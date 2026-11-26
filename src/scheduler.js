"use strict";
/**
 * 调度器：程序实例池的全生命周期管理。
 *
 *   实例状态：starting → ready ⇄ busy → idle → stopping → (移除)；starting 超时/失败 → failed（换卡/换机重试）
 *   观众：按程序排队（FIFO）→ 分配到有空位且负载最低的实例；没有就按需扩容。
 *   扩缩容：期望实例数 = ceil((已分配 + 排队观众) / 单实例容量) + 预热数，上限 max_instances；
 *           空闲超过 idle_release_sec 且超出期望数的实例被回收。
 *   放置：在线且启用的 Agent ∩ 程序允许的机器；GPU 按"可用显存 − 已预留"最大优先，其次实例少、利用率低。
 *
 * 本模块只维护状态并发出事件，不直接操作 WebSocket：
 *   'assigned'(player, inst)  'queued'(player, position)  'released'(player, inst)  'ueLost'(player)
 *   'rejected'(player, reason)  'preempted'(player)（为 VIP 让出位置）  'changed'()  'warning'(text)
 */
const { EventEmitter } = require("events");
const { newId, splitArgs } = require("./util.js");

const ACTIVE = new Set(["starting", "ready", "busy", "idle"]);
const SERVING = new Set(["ready", "busy", "idle"]);
const MAX_ATTEMPTS = 3;
const BAD_SLOT_MS = 2 * 60 * 1000;
const RESERVE_HOLD_MS = 30 * 1000;
const STOP_GRACE_MS = 15 * 1000;

class Scheduler extends EventEmitter {
	constructor({ store, agents, log, defaultUeHost, ueProto = "ws" }) {
		super();
		this.ueProto = ueProto; // ws 或 wss（管理口启用 TLS 时）
		this.store = store;
		this.agents = agents;
		this.log = log;
		this.defaultUeHost = defaultUeHost; // 内置 Agent / 无法确定时 UE 连接平台用的 host:port
		this.programs = new Map(); // id -> { def, queue: Player[], lastError, badSlots: Map }
		this.instances = new Map(); // id -> Instance
		this.byProgram = new Map(); // programId -> Set<Instance>（索引，避免热路径全表扫描）
		this.byMachine = new Map(); // machineId -> Set<Instance>
		this.reservations = new Map(); // instanceId -> { machineId, gpu, mb, until }
		this.retired = new Map(); // 已停止/失败的平台实例 ID -> 过期时间：拒绝其 UE 迟到的重连（防止僵尸进程接管观众）
		this.loadPrograms();

		agents.on("started", (conn, m) => this.onProcStarted(conn, m));
		agents.on("exited", (conn, m) => this.onProcExited(conn, m, null));
		agents.on("error", (conn, m) => this.onProcExited(conn, m, m.message || "error"));
		agents.on("offline", (conn) => this.onAgentOffline(conn));
		agents.on("online", (conn) => {
			this.reconcile(conn); // 先接管 Agent 上仍在运行的实例，再按需扩容（避免平台重启后重复拉起）
			this.scaleAll();
		});
		agents.on("stats", (conn) => {
			this.releaseReservations(conn);
			this.reconcile(conn);
		});

		this.timer = setInterval(() => this.tick(), 2000);
		this.timer.unref?.();
	}

	stop() {
		clearInterval(this.timer);
	}

	/* ----------------------------------------------------------- 程序 */

	loadPrograms() {
		const defs = this.store.listPrograms();
		const seen = new Set();
		for (const def of defs) {
			seen.add(def.id);
			const rt = this.programs.get(def.id);
			if (rt) rt.def = def;
			else this.programs.set(def.id, { def, queue: [], lastError: null, badSlots: new Map() });
		}
		for (const [id, rt] of this.programs) {
			if (seen.has(id)) continue;
			// 程序被删除：先停止实例（其观众会被放回队列），再拒绝队列中的所有观众，避免观众滞留在已删除程序的队列里
			for (const inst of this.instancesOf(id)) this.stopInstance(inst.id, "program deleted");
			for (const p of rt.queue.splice(0)) this.emit("rejected", p, "程序已删除");
			this.programs.delete(id);
		}
		for (const [id, rt] of this.programs) {
			if (!rt.def.enabled) {
				for (const p of rt.queue.splice(0)) this.emit("rejected", p, "程序已停用");
				for (const inst of this.instancesOf(id)) if (inst.managed) this.drainInstance(inst.id);
			}
		}
		this.scaleAll();
		this.emit("changed");
	}

	capacity(def) {
		return def.mode === "shared" ? Math.max(1, def.max_viewers | 0) : 1;
	}

	/** 根据路径首段/查询参数解析程序；找不到时：只有一个启用程序就用它 */
	resolveProgram(id) {
		if (id && this.programs.has(id)) return this.programs.get(id);
		// 程序 ID 统一小写；兼容企业版大小写混用的 urlPrefix（如 ?urlPrefix=JJQ → 程序 jjq）
		if (id && this.programs.has(String(id).toLowerCase())) return this.programs.get(String(id).toLowerCase());
		const enabled = [...this.programs.values()].filter((rt) => rt.def.enabled);
		if (!id && enabled.length === 1) return enabled[0];
		if (!id && this.programs.has("default")) return this.programs.get("default");
		return null;
	}

	instancesOf(programId) {
		return [...(this.byProgram.get(programId) || [])];
	}

	addInstance(inst) {
		this.instances.set(inst.id, inst);
		for (const [map, key] of [
			[this.byProgram, inst.programId],
			[this.byMachine, inst.machineId],
		]) {
			if (!map.has(key)) map.set(key, new Set());
			map.get(key).add(inst);
		}
	}

	/** 排队位置通知合并：每个程序每秒最多推送一次，避免 O(排队人数²) 的消息风暴 */
	notifyQueue(rt) {
		if (rt.queueTimer) return;
		rt.queueTimer = setTimeout(() => {
			rt.queueTimer = null;
			rt.queue.forEach((p, i) => {
				if (p.queuePos !== i + 1) {
					p.queuePos = i + 1;
					this.emit("queued", p, i + 1);
				}
			});
		}, rt.queueNotifiedAt && Date.now() - rt.queueNotifiedAt < 1000 ? 1000 : 0);
		rt.queueTimer.unref?.();
		rt.queueNotifiedAt = Date.now();
	}

	/* ----------------------------------------------------------- 观众 */

	join(player) {
		const rt = this.programs.get(player.programId);
		if (!rt) return this.emit("rejected", player, "程序不存在");
		if (!rt.def.enabled) return this.emit("rejected", player, "程序已停用");
		player.queuedAt = Date.now();
		if (player.vip) {
			// VIP 访问链接：排在所有普通观众之前（VIP 之间先到先得）
			const i = rt.queue.findIndex((q) => !q.vip);
			rt.queue.splice(i < 0 ? rt.queue.length : i, 0, player);
		} else rt.queue.push(player);
		this.dispatch(rt);
	}

	leave(player, reason = "closed") {
		const rt = this.programs.get(player.programId);
		if (rt) {
			const i = rt.queue.indexOf(player);
			if (i >= 0) rt.queue.splice(i, 1);
		}
		const inst = player.instance;
		if (inst) {
			inst.viewers.delete(player);
			player.instance = null;
			this.emit("released", player, inst, reason);
			if (inst.viewers.size === 0 && SERVING.has(inst.state)) {
				if (rt?.def.fresh_instance && inst.managed && !inst.draining) {
					// 每位观众使用全新实例：观众离开即关闭，不把用过的 UE（场景状态、登录信息等）交给下一位观众
					this.stopInstance(inst.id, "viewer left (fresh instance)");
				} else {
					inst.state = "idle";
					inst.idleSince = Date.now();
					if (inst.draining) this.stopInstance(inst.id, "drained");
				}
			}
		}
		if (rt) this.dispatch(rt);
		this.emit("changed");
	}

	/** 把排队观众分配到可用实例（按 pickInstance 的负载均衡顺序）；VIP 观众等不到实例时可抢占 */
	dispatch(rt) {
		this.assign(rt);
		this.scale(rt);
		if (rt.queue[0]?.vip && rt.def.vip_preempt !== false && this.preemptForVip(rt)) this.assign(rt);
		if (rt.queue.length) this.notifyQueue(rt);
		this.emit("changed");
	}

	assign(rt) {
		const cap = this.capacity(rt.def);
		while (rt.queue.length) {
			const inst = this.pickInstance(rt.def.id, cap);
			if (!inst) break;
			const p = rt.queue.shift();
			inst.viewers.add(p);
			inst.used = true;
			p.instance = inst;
			p.queuePos = 0;
			p.assignedAt = Date.now();
			inst.state = "busy";
			inst.idleSince = null;
			this.emit("assigned", p, inst);
		}
	}

	/**
	 * VIP 观众排在队首、又没有即将可用的实例（启动中实例的空位）时，断开一位观看时间最长的普通观众，把位置让给 VIP。
	 * 每位 VIP 最多触发一次（被让出的位置可能还要等实例重新启动），不会断开其他 VIP。返回是否断开了观众。
	 */
	preemptForVip(rt) {
		const cap = this.capacity(rt.def);
		const insts = this.instancesOf(rt.def.id).filter((i) => ACTIVE.has(i.state) && !i.draining);
		let coming = insts.filter((i) => !i.ueReady).reduce((s, i) => s + Math.max(0, cap - i.viewers.size), 0);
		let evicted = 0;
		for (const vip of [...rt.queue]) {
			if (!vip.vip) break; // VIP 都排在队首
			if (vip.instance || vip.closed || !rt.queue.includes(vip)) continue; // 已在下面的 leave() → dispatch 中分配到实例
			if (coming > 0) {
				coming--;
				continue;
			}
			if (vip.preemptDone) continue;
			let victim = null;
			for (const inst of insts) {
				if (!inst.ueReady || !SERVING.has(inst.state)) continue;
				for (const p of inst.viewers) if (!p.vip && !p.preempted && (!victim || (p.assignedAt || 0) < (victim.assignedAt || 0))) victim = p;
			}
			if (!victim) break;
			vip.preemptDone = true;
			victim.preempted = true;
			this.log.info(`[scheduler] 程序 ${rt.def.id} 已满，为 VIP 观众让出位置：断开观众 ${victim.id}（${victim.ip || ""}，已观看 ${Math.round((Date.now() - (victim.assignedAt || Date.now())) / 1000)} 秒）`);
			this.emit("preempted", victim);
			this.leave(victim, "preempted by vip");
			evicted++;
		}
		return evicted > 0;
	}

	pickInstance(programId, cap) {
		const fresh = this.programs.get(programId)?.def.fresh_instance;
		let best = null;
		for (const inst of this.byProgram.get(programId) || []) {
			if (!SERVING.has(inst.state) || inst.draining || !inst.ueReady) continue;
			if (inst.viewers.size >= cap) continue;
			if (fresh && inst.managed && inst.used) continue; // 用过的实例正在关闭，不再分配
			if (!best || inst.viewers.size < best.viewers.size || (inst.viewers.size === best.viewers.size && inst.readyAt < best.readyAt)) best = inst;
		}
		return best;
	}

	/* ----------------------------------------------------------- 扩缩容 */

	desiredInstances(rt) {
		const def = rt.def;
		const cap = this.capacity(def);
		const insts = this.instancesOf(def.id).filter((i) => ACTIVE.has(i.state) && !i.draining);
		const assigned = insts.reduce((s, i) => s + i.viewers.size, 0);
		const prewarm = inHours(def.prewarm_hours) ? def.prewarm | 0 : 0; // 预热时段之外不保留空闲实例
		const demand = Math.ceil((assigned + rt.queue.length) / cap) + prewarm;
		return { desired: Math.min(demand, def.max_instances | 0), active: insts };
	}

	scaleAll() {
		for (const rt of this.programs.values()) this.scale(rt);
	}

	scale(rt) {
		const def = rt.def;
		if (!def.enabled || !hasExe(def)) return; // 未配置可执行文件：只接受手动启动的 UE
		const { desired, active } = this.desiredInstances(rt);
		const managedActive = active.filter((i) => i.managed || i.ueReady);
		let toStart = desired - managedActive.length;
		while (toStart-- > 0) {
			const ok = this.launch(rt);
			if (!ok) break;
		}
	}

	/** 选择放置位置并下发启动命令 */
	launch(rt, opts = {}) {
		const def = rt.def;
		const slot = opts.slot || this.place(rt);
		if (!slot) {
			const msg = `程序 ${def.id} 没有可用的机器/GPU（检查 Agent 是否在线、显存与实例上限）`;
			if (rt.lastError !== msg) this.log.warn(`[scheduler] ${msg}`);
			rt.lastError = msg;
			this.emit("warning", msg);
			return null;
		}
		const inst = {
			id: newId(10),
			programId: def.id,
			machineId: slot.agent.machineId,
			gpu: slot.gpu,
			state: "starting",
			managed: true,
			ue: null,
			ueReady: false,
			viewers: new Set(),
			createdAt: Date.now(),
			readyAt: 0,
			idleSince: null,
			deadline: Date.now() + Math.max(10, def.startup_timeout_sec) * 1000,
			attempt: opts.attempt || 1,
			pid: null,
			draining: false,
			lastError: null,
		};
		const ueHost = slot.agent.ueHost || this.defaultUeHost;
		const args = buildArgs(def, `${this.ueProto}://${ueHost}/ue/${def.id}/${inst.id}`, slot.gpu);
		this.addInstance(inst);
		if (def.gpu_mem_mb) this.reservations.set(inst.id, { machineId: inst.machineId, gpu: slot.gpu, mb: def.gpu_mem_mb, until: 0 });
		const exe = def.exe_overrides?.[slot.agent.machineId] || def.exe; // 不同机器可配置不同安装路径
		const sent = slot.agent.send({ type: "start", instanceId: inst.id, programId: def.id, gpu: slot.gpu, exe, args, cwd: def.cwd || undefined });
		if (!sent) {
			this.removeInstance(inst, "send failed");
			return null;
		}
		// 注意：不在这里清空 rt.lastError——重试期间仍需让管理员看到上一次失败原因，实例真正就绪（ueReady）时才清空
		this.log.info(`[scheduler] 启动实例 ${inst.id} 程序=${def.id} 机器=${inst.machineId} GPU=${slot.gpu} (第 ${inst.attempt} 次)`);
		this.emit("changed");
		return inst;
	}

	place(rt, { machineId } = {}) {
		const def = rt.def;
		const now = Date.now();
		let best = null;
		for (const agent of this.agents.online()) {
			if (machineId && agent.machineId !== machineId) continue;
			if (def.machines?.length && !def.machines.includes(agent.machineId)) continue;
			if (!def.exe && !def.exe_overrides?.[agent.machineId]) continue; // 该机器上没有配置路径
			const m = this.store.getMachine(agent.machineId);
			const onMachine = [...(this.byMachine.get(agent.machineId) || [])].filter((i) => ACTIVE.has(i.state));
			if (m?.max_instances && onMachine.length >= m.max_instances) continue;
			// GPU 来源：Agent 实时上报（NVIDIA）> 管理员手动定义（国产/AMD 等无 nvidia-smi 的显卡）> 单槽位
			const live = agent.gpus?.length > 0;
			const gpus = live ? agent.gpus : m?.gpus_override?.length ? m.gpus_override : [{ index: 0, memTotalMB: 0, memUsedMB: 0, util: 0 }];
			for (const g of gpus) {
				const key = `${agent.machineId}#${g.index}`;
				if ((rt.badSlots.get(key) || 0) > now) continue;
				let free;
				if (!g.memTotalMB) free = Number.MAX_SAFE_INTEGER;
				else if (live) {
					const reserved = [...this.reservations.values()].filter((r) => r.machineId === agent.machineId && r.gpu === g.index).reduce((s, r) => s + r.mb, 0);
					free = g.memTotalMB - g.memUsedMB - reserved;
				} else {
					// 手动定义的 GPU 没有实时显存：按其上运行实例的程序估算显存累计
					const used = onMachine.filter((i) => i.gpu === g.index).reduce((s, i) => s + (this.programs.get(i.programId)?.def.gpu_mem_mb || 0), 0);
					free = g.memTotalMB - used;
				}
				if (def.gpu_mem_mb && g.memTotalMB && free < def.gpu_mem_mb) continue;
				const onGpu = onMachine.filter((i) => i.gpu === g.index).length;
				const score = [free, -onGpu, -(g.util || 0)];
				if (!best || compare(score, best.score) > 0) best = { agent, gpu: g.index, score };
			}
		}
		return best;
	}

	releaseReservations(conn) {
		const now = Date.now();
		for (const [id, r] of this.reservations) {
			if (r.machineId !== conn.machineId) continue;
			if (r.until && r.until < now) this.reservations.delete(id);
		}
	}

	/* ----------------------------------------------------------- UE */

	/**
	 * UE 连接。path 形如 /ue/<程序>/<实例ID>（平台启动的实例）；也兼容 /、/<程序>、/<程序>/<任意>（手动/旧版启动的 UE）。
	 * 返回 instance（或 null + reason）
	 */
	ueConnected(ue, { programId, instanceId }) {
		if (instanceId && (this.retired.get(instanceId) || 0) > Date.now()) return { inst: null, reason: `实例 ${instanceId} 已停止`, retired: true };
		let inst = instanceId ? this.instances.get(instanceId) : null;
		if (inst && inst.managed && inst.state !== "starting") return { inst: null, reason: `实例 ${instanceId} 状态为 ${inst.state}，拒绝重复连接`, retired: true };
		if (inst && inst.programId === programId && inst.state === "starting" && !inst.ue) {
			inst.ue = ue;
			this.log.info(`[scheduler] 实例 ${inst.id} 的 UE 已连接`);
		} else {
			const rt = this.resolveProgram(programId);
			if (!rt) return { inst: null, reason: `未知程序 ${programId || "(空)"}` };
			inst = {
				id: instanceId && !this.instances.has(instanceId) ? instanceId : newId(10),
				programId: rt.def.id,
				machineId: "manual",
				gpu: null,
				state: "starting",
				managed: false,
				ue,
				ueReady: false,
				viewers: new Set(),
				createdAt: Date.now(),
				readyAt: 0,
				idleSince: null,
				deadline: Infinity,
				attempt: 1,
				pid: null,
				draining: false,
				lastError: null,
			};
			this.addInstance(inst);
			this.log.info(`[scheduler] 手动实例 ${inst.id} 加入程序 ${inst.programId}`);
		}
		this.emit("changed");
		return { inst };
	}

	/** UE 就绪（像素流1 超时判定 / 像素流2 收到 endpointId） */
	ueReady(inst) {
		if (!this.instances.has(inst.id) || inst.ueReady) return;
		inst.ueReady = true;
		inst.readyAt = Date.now();
		inst.state = inst.viewers.size ? "busy" : "idle";
		inst.idleSince = inst.viewers.size ? null : Date.now();
		const r = this.reservations.get(inst.id);
		if (r) r.until = Date.now() + RESERVE_HOLD_MS; // 等 Agent 下一轮上报真实显存后释放预留
		const rt = this.programs.get(inst.programId);
		if (rt) {
			rt.lastError = null;
			this.dispatch(rt);
		}
	}

	ueClosed(inst, reason = "ue closed") {
		if (!this.instances.has(inst.id)) return;
		inst.ue = null;
		inst.ueReady = false;
		this.log.info(`[scheduler] 实例 ${inst.id} 的 UE 断开（${reason}）`);
		const rt = this.programs.get(inst.programId);
		// 观众放回队首，立即重新分配
		const viewers = [...inst.viewers];
		inst.viewers.clear();
		for (const p of viewers) {
			p.instance = null;
			this.emit("ueLost", p, inst);
		}
		if (rt) rt.queue.unshift(...viewers.filter((p) => !p.closed));
		this.removeInstance(inst, reason);
		if (inst.managed && inst.state !== "stopping") this.agents.get(inst.machineId)?.send({ type: "stop", instanceId: inst.id });
		if (rt) this.dispatch(rt);
	}

	removeInstance(inst, reason) {
		if (!this.instances.has(inst.id)) return;
		if (inst.managed) this.retired.set(inst.id, Date.now() + 10 * 60 * 1000);
		this.instances.delete(inst.id);
		this.byProgram.get(inst.programId)?.delete(inst);
		this.byMachine.get(inst.machineId)?.delete(inst);
		this.reservations.delete(inst.id);
		clearTimeout(inst.stopTimer);
		inst.removedReason = reason;
		this.emit("removed", inst, reason);
		this.emit("changed");
	}

	/* ----------------------------------------------------------- Agent 事件 */

	onProcStarted(conn, { instanceId, pid }) {
		const inst = this.instances.get(instanceId);
		if (inst) {
			inst.pid = pid;
			this.emit("changed");
		}
	}

	onProcExited(conn, { instanceId, code }, error) {
		const inst = this.instances.get(instanceId);
		if (!inst) return;
		const rt = this.programs.get(inst.programId);
		if (inst.state === "stopping") {
			// 主动停止的实例：无论 Agent 报告退出还是"未在运行"，都直接移除，不触发重试
			if (inst.ue) {
				try {
					inst.ue.close(1000, "instance stopped");
				} catch {}
			}
			this.removeInstance(inst, "stopped");
			if (rt) this.dispatch(rt);
			return;
		}
		if (inst.state === "starting" || error) {
			const why = error || `进程退出 code=${code}`;
			this.failInstance(inst, why);
			return;
		}
		// 运行中意外退出：UE 连接通常也会随之断开；若还挂着则等其 close 事件
		if (!inst.ue) {
			this.removeInstance(inst, `exited code=${code}`);
			if (rt) this.dispatch(rt);
		}
	}

	/** backoff=false：失败与该 GPU 槽位无关（如 Agent 断线），不让槽位进入退避，Agent 重连后立即可用 */
	failInstance(inst, why, { backoff = true } = {}) {
		const rt = this.programs.get(inst.programId);
		this.log.warn(`[scheduler] 实例 ${inst.id} 启动失败：${why}`);
		inst.state = "failed";
		inst.lastError = why;
		if (rt) {
			rt.lastError = `实例启动失败：${why}`;
			if (backoff && inst.gpu !== null) rt.badSlots.set(`${inst.machineId}#${inst.gpu}`, Date.now() + BAD_SLOT_MS);
		}
		this.agents.get(inst.machineId)?.send({ type: "stop", instanceId: inst.id });
		if (inst.ue) {
			try {
				inst.ue.close(1011, "startup failed");
			} catch {}
		}
		const viewers = [...inst.viewers];
		inst.viewers.clear();
		this.removeInstance(inst, `failed: ${why}`);
		if (rt) {
			rt.queue.unshift(...viewers.filter((p) => !p.closed));
			// 有限次重试：换 GPU/机器（失败的槽位已进入退避，不会再选中）
			const { desired, active } = this.desiredInstances(rt);
			if (inst.attempt < MAX_ATTEMPTS && (rt.queue.length || desired > active.length)) {
				const next = this.launch(rt, { attempt: inst.attempt + 1 });
				if (!next) this.dispatch(rt);
			} else this.dispatch(rt);
		}
	}

	/**
	 * 对账：Agent 上报的进程表 vs 平台记录的实例。
	 *  - 平台不认识、但程序仍有效的进程（平台重启 / Agent 重连后）→ 接管为受管实例，UE 重连后继续服务
	 *  - 已停止 / 失败 / 程序已删除的进程 → 下发停止，杜绝占用显卡的孤儿进程
	 *  - UE 先于 Agent 重连而被当成"手动实例"的 → 转回受管实例（恢复空闲回收、停止等管理能力）
	 *  - 平台记录在运行、但进程已不在（Agent 断线期间退出）→ 按退出处理
	 */
	reconcile(conn) {
		if (!conn || conn.legacy || !Array.isArray(conn.procs)) return;
		const now = Date.now();
		const seen = new Set();
		let changed = false;
		for (const p of conn.procs) {
			const id = typeof p?.instanceId === "string" ? p.instanceId : "";
			if (!id) continue;
			seen.add(id);
			const inst = this.instances.get(id);
			if (inst) {
				if (!inst.managed && inst.programId === p.programId) {
					this.byMachine.get(inst.machineId)?.delete(inst);
					Object.assign(inst, { managed: true, adopted: true, machineId: conn.machineId, gpu: p.gpu ?? null, pid: p.pid || null });
					if (!this.byMachine.has(conn.machineId)) this.byMachine.set(conn.machineId, new Set());
					this.byMachine.get(conn.machineId).add(inst);
					this.log.info(`[scheduler] 实例 ${id} 转为受管（机器 ${conn.machineId} pid=${p.pid}）`);
					changed = true;
				} else if (inst.managed && !inst.pid && p.pid) inst.pid = p.pid;
				continue;
			}
			const rt = p.programId ? this.programs.get(p.programId) : null;
			if ((this.retired.get(id) || 0) > now || !rt || !rt.def.enabled) {
				this.log.info(`[scheduler] 清理 ${conn.machineId} 上的遗留进程 ${id}（pid=${p.pid}）`);
				conn.send({ type: "stop", instanceId: id });
				this.retired.set(id, now + 10 * 60 * 1000);
				continue;
			}
			const def = rt.def;
			this.addInstance({
				id,
				programId: def.id,
				machineId: conn.machineId,
				gpu: p.gpu ?? null,
				state: "starting",
				managed: true,
				adopted: true,
				ue: null,
				ueReady: false,
				viewers: new Set(),
				createdAt: now,
				readyAt: 0,
				idleSince: null,
				deadline: now + Math.max(10, def.startup_timeout_sec) * 1000,
				attempt: 1,
				pid: p.pid || null,
				draining: false,
				lastError: null,
			});
			this.log.info(`[scheduler] 接管 ${conn.machineId} 上仍在运行的实例 ${id}（程序 ${def.id} pid=${p.pid}），等待 UE 重连`);
			changed = true;
		}
		for (const inst of [...(this.byMachine.get(conn.machineId) || [])]) {
			if (!inst.managed || !inst.pid || seen.has(inst.id) || inst.ue) continue;
			this.onProcExited(conn, { instanceId: inst.id, code: null }, inst.state === "stopping" ? null : "进程已不在运行");
			changed = true;
		}
		if (changed) this.emit("changed");
	}

	onAgentOffline(conn) {
		for (const inst of [...(this.byMachine.get(conn.machineId) || [])]) {
			// 启动中的实例无法确认结果，判失败；已运行的实例由 UE 连接决定去留
			if (inst.state === "starting" && !inst.ue) this.failInstance(inst, "Agent 离线", { backoff: false });
		}
	}

	/* ----------------------------------------------------------- 管理操作 */

	startInstance(programId, { machineId } = {}) {
		const rt = this.programs.get(programId);
		if (!rt) throw httpError(404, "程序不存在");
		if (!hasExe(rt.def)) throw httpError(400, "该程序未配置可执行文件，无法由平台启动");
		const active = this.instancesOf(programId).filter((i) => ACTIVE.has(i.state));
		if (active.length >= rt.def.max_instances) throw httpError(409, `已达到最大实例数 ${rt.def.max_instances}`);
		const slot = this.place(rt, { machineId });
		if (!slot) throw httpError(409, machineId ? `机器 ${machineId} 不可用` : "没有可用的机器/GPU");
		return this.launch(rt, { slot });
	}

	stopInstance(id, reason = "stopped by admin") {
		const inst = this.instances.get(id);
		if (!inst) return false;
		const rt = this.programs.get(inst.programId);
		if (inst.state === "stopping") return true;
		inst.state = "stopping";
		inst.draining = true;
		const viewers = [...inst.viewers];
		inst.viewers.clear();
		for (const p of viewers) {
			p.instance = null;
			this.emit("ueLost", p, inst);
		}
		if (rt) rt.queue.unshift(...viewers.filter((p) => !p.closed));
		if (inst.managed) this.agents.get(inst.machineId)?.send({ type: "stop", instanceId: inst.id });
		if (inst.ue) {
			const ue = inst.ue;
			setTimeout(() => {
				try {
					ue.close(1000, "instance stopped");
				} catch {}
			}, inst.managed ? 3000 : 0).unref?.();
		}
		inst.stopTimer = setTimeout(() => this.removeInstance(inst, reason), STOP_GRACE_MS);
		inst.stopTimer.unref?.();
		this.log.info(`[scheduler] 停止实例 ${id}（${reason}）`);
		if (rt) this.dispatch(rt);
		this.emit("changed");
		return true;
	}

	/** 排空：不再接新观众，现有观众离开后自动停止 */
	drainInstance(id) {
		const inst = this.instances.get(id);
		if (!inst) return false;
		inst.draining = true;
		if (inst.viewers.size === 0) this.stopInstance(id, "drained");
		this.emit("changed");
		return true;
	}

	/* ----------------------------------------------------------- 定时任务 */

	tick() {
		const now = Date.now();
		for (const inst of [...this.instances.values()]) {
			if (inst.state === "starting" && inst.managed && now > inst.deadline) {
				this.failInstance(inst, inst.ue ? "UE 已连接但未就绪（超时）" : `${Math.round((now - inst.createdAt) / 1000)} 秒内 UE 未连接平台`);
			}
		}
		for (const rt of this.programs.values()) {
			const def = rt.def;
			const { desired, active } = this.desiredInstances(rt);
			let surplus = active.filter((i) => i.managed).length - desired;
			if (surplus > 0) {
				const idle = active
					.filter((i) => i.managed && i.state === "idle" && i.viewers.size === 0 && now - i.idleSince > def.idle_release_sec * 1000)
					.sort((a, b) => a.idleSince - b.idleSince);
				for (const inst of idle) {
					if (surplus-- <= 0) break;
					this.stopInstance(inst.id, `idle ${def.idle_release_sec}s`);
				}
			}
			this.scale(rt);
		}
		// 清理过期的失败退避记录 / 退役实例 ID
		for (const rt of this.programs.values()) {
			for (const [slot, until] of rt.badSlots) if (until < now) rt.badSlots.delete(slot);
		}
		for (const [id, until] of this.retired) if (until < now) this.retired.delete(id);
	}

	/* ----------------------------------------------------------- 快照 */

	snapshot() {
		const programs = [...this.programs.values()].map((rt) => {
			const insts = this.instancesOf(rt.def.id);
			const count = (s) => insts.filter((i) => i.state === s).length;
			return {
				id: rt.def.id,
				name: rt.def.name,
				enabled: rt.def.enabled,
				mode: rt.def.mode,
				capacity: this.capacity(rt.def),
				max_instances: rt.def.max_instances,
				prewarm: rt.def.prewarm,
				queue: rt.queue.length,
				viewers: insts.reduce((s, i) => s + i.viewers.size, 0),
				instances: { total: insts.length, starting: count("starting"), busy: count("busy"), idle: count("idle"), stopping: count("stopping") },
				lastError: rt.lastError,
			};
		});
		const instances = [...this.instances.values()].map((i) => ({
			id: i.id,
			programId: i.programId,
			machineId: i.machineId,
			gpu: i.gpu,
			state: i.state,
			managed: i.managed,
			ueReady: i.ueReady,
			ueVersion: i.ueVersion || null,
			viewers: i.viewers.size,
			draining: i.draining,
			pid: i.pid,
			createdAt: i.createdAt,
			readyAt: i.readyAt || null,
			idleSince: i.idleSince,
			attempt: i.attempt,
			ueIp: i.ue?.ip || null,
		}));
		return { programs, instances };
	}
}

/** 生成 UE 启动参数：平台负责连接地址/GPU/分辨率，程序自定义参数在前且不会被重复添加 */
function buildArgs(def, url, gpu) {
	const user = splitArgs(def.args).filter((a) => !/^-PixelStreamingURL=/i.test(a) && !/^-PixelStreamingConnectionURL=/i.test(a));
	const has = (flag) => user.some((a) => a.toLowerCase().startsWith(flag.toLowerCase()));
	const out = [...user, `-PixelStreamingURL=${url}`];
	const add = (flag, value) => !has(flag) && out.push(value === undefined ? flag : `${flag}=${value}`);
	if (gpu !== null && gpu !== undefined) add("-graphicsadapter", gpu);
	add("-RenderOffScreen");
	add("-Unattended");
	if (def.allow_commands) add("-AllowPixelStreamingCommands"); // 观众可执行控制台命令：仅在明确需要时开启
	if (def.audio) add("-AudioMixer");
	if (def.max_bitrate_mbps) add("-PixelStreamingWebRTCMaxBitrate", Math.round(def.max_bitrate_mbps * 1e6));
	if (def.min_bitrate_mbps) add("-PixelStreamingWebRTCMinBitrate", Math.round(def.min_bitrate_mbps * 1e6));
	if (def.res_x && def.res_y) {
		add("-ForceRes");
		add("-ResX", def.res_x);
		add("-ResY", def.res_y);
	}
	if (def.fps) add("-PixelStreamingWebRTCFps", def.fps);
	return out;
}

const hasExe = (def) => !!(def.exe || Object.keys(def.exe_overrides || {}).length);

/** "8-20" → 8:00~20:00；"22-6" 跨午夜；空 = 全天 */
function inHours(spec, d = new Date()) {
	if (!spec) return true;
	const [a, b] = String(spec).split("-").map(Number);
	const h = d.getHours();
	return a <= b ? h >= a && h < b : h >= a || h < b;
}

function compare(a, b) {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
	return 0;
}

function httpError(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

module.exports = { Scheduler, buildArgs, inHours };
