"use strict";
/**
 * Agent 中心：管理渲染节点连接（ps-agent 协议、旧版 exec-ue、进程内本机 Agent），
 * 维护每台机器的 GPU/CPU/进程状态，并把进程事件转交调度器。
 */
const { EventEmitter } = require("events");
const { normalizeIp } = require("./util.js");

const DUPLICATE_STALE_MS = 15 * 1000; // Agent 每 5 秒上报一次：超过 15 秒没有上报的旧连接视为已失效

class AgentHub extends EventEmitter {
	constructor({ store, log }) {
		super();
		this.store = store;
		this.log = log;
		this.agents = new Map(); // machineId -> conn
	}

	/** 当前在线且已启用的 Agent */
	online() {
		return [...this.agents.values()].filter((a) => a.ready && this.store.getMachine(a.machineId)?.enabled !== false);
	}

	get(machineId) {
		return this.agents.get(machineId);
	}

	/**
	 * 接入一个 ps-agent WebSocket。ueHost = Agent 连接平台时用的 host:port（UE 在同一台机器上也能用它连回平台）
	 */
	/** ps-agent 连接使用的机器 ID（--id，未指定时按来源地址生成） */
	machineIdFor(id, ip) {
		return sanitizeId(id) || `agent-${normalizeIp(ip)}`;
	}

	/**
	 * 机器 ID 是否已被另一台在线的渲染机占用（返回占用者，否则 null）。
	 * 两台渲染机用同一个 ID 时若互相替换，会每隔一两秒把对方踢下线（其上的实例全部失败、观众被断开），所以拒绝后来者。
	 * 同一地址（Agent 重启、断线重连）或旧连接已无响应时不算冲突，照常替换；平台内置的本机 Agent 的 ID 不能被外部 Agent 占用。
	 */
	conflictFor(machineId, ip) {
		const prev = this.agents.get(machineId);
		if (!prev) return null;
		const fresh = prev.ready && Date.now() - prev.lastStatsAt < DUPLICATE_STALE_MS;
		return prev.local || (fresh && prev.ip !== normalizeIp(ip)) ? prev : null;
	}

	reportConflict(conn, holder) {
		this.log.error(`[agents] 机器 ID「${conn.machineId}」已被 ${holder.local ? "平台内置的本机 Agent" : holder.ip} 使用，拒绝来自 ${conn.ip} 的接入：请为该渲染机换一个机器名称（重新运行安装程序修改，或命令行 --id）`);
		this.emit("conflict", conn, holder);
	}

	attachWs(ws, { id, ip, ueHost, legacy = false }) {
		const conn = {
			machineId: legacy ? `legacy-${normalizeIp(ip).replace(/[^0-9a-f]/gi, "-")}` : this.machineIdFor(id, ip),
			ip: normalizeIp(ip),
			ueHost,
			legacy,
			ready: legacy, // ps-agent 收到 hello 后才就绪
			gpus: [],
			cpu: 0,
			memUsedMB: 0,
			memTotalMB: 0,
			procs: [],
			connectedAt: Date.now(),
			lastStatsAt: Date.now(),
			send: (m) => {
				if (ws.readyState !== 1) return false;
				if (legacy) {
					if (m.type === "start") ws.send(legacyCommand(m));
					return m.type === "start";
				}
				ws.send(JSON.stringify(m));
				return true;
			},
			close: () => ws.terminate(),
			reject: (code, reason) => {
				try {
					ws.close(code, reason);
				} catch {}
				setTimeout(() => ws.terminate(), 2000).unref?.();
			},
		};
		if (legacy) this.register(conn, { hostname: conn.machineId, platform: "exec-ue (legacy)", version: "legacy" });
		// 心跳：信令层每 30s ping 一次，连续两次没有 pong 才断开；收到 pong 或任何消息都算存活
		ws.isAlive = true;
		ws.on("pong", () => (ws.isAlive = true));
		ws.on("message", (raw) => {
			ws.isAlive = true;
			let msg;
			try {
				msg = JSON.parse(raw);
			} catch {
				return;
			}
			this.onMessage(conn, msg);
		});
		ws.on("close", () => this.detach(conn));
		ws.on("error", () => {});
		return conn;
	}

	/** 进程内本机 Agent（createAgent 实例） */
	attachLocal(createAgent, { machineId = "local", ueHost, allowExe = [], stateFile = null } = {}) {
		const conn = {
			machineId,
			ip: "127.0.0.1",
			ueHost,
			legacy: false,
			local: true,
			ready: false,
			gpus: [],
			cpu: 0,
			memUsedMB: 0,
			memTotalMB: 0,
			procs: [],
			connectedAt: Date.now(),
			lastStatsAt: Date.now(),
		};
		const agent = createAgent({
			machineId,
			allowExe,
			stateFile,
			log: this.log,
			send: (m) => setImmediate(() => this.onMessage(conn, m)),
		});
		conn.send = (m) => {
			setImmediate(() => agent.handle(m));
			return true;
		};
		conn.close = () => agent.close();
		conn.agent = agent;
		agent.hello();
		return conn;
	}

	register(conn, info) {
		const prev = this.agents.get(conn.machineId);
		if (prev && prev !== conn) {
			// 连接建立时已检查过（signaling 返回 409）；这里兜底两个 Agent 几乎同时接入的情况
			const holder = conn.local ? null : this.conflictFor(conn.machineId, conn.ip);
			if (holder) {
				this.reportConflict(conn, holder);
				conn.ready = false;
				conn.rejected = true;
				conn.reject?.(4409, "duplicate machine id");
				return;
			}
			this.log.warn(`[agents] ${conn.machineId} 重复连接，替换旧连接`);
			this.agents.delete(conn.machineId);
			try {
				prev.close();
			} catch {}
		}
		conn.hostname = info.hostname;
		conn.platform = info.platform;
		conn.version = info.version;
		conn.cpus = info.cpus;
		conn.memTotalMB = info.memTotalMB || 0;
		if (Array.isArray(info.gpus)) conn.gpus = info.gpus;
		if (Array.isArray(info.procs)) conn.procs = info.procs; // 先拿到进程表，调度器上线时据此接管/清理
		conn.ready = true;
		this.agents.set(conn.machineId, conn);
		this.store.touchMachine(conn.machineId, {
			host: conn.ip,
			name: info.hostname,
			info: { hostname: info.hostname, platform: info.platform, version: info.version, cpus: info.cpus, memTotalMB: conn.memTotalMB, gpus: conn.gpus.map((g) => ({ index: g.index, name: g.name, memTotalMB: g.memTotalMB })) },
		});
		this.log.info(`[agents] ${conn.machineId} 上线 (${info.platform}, GPU×${conn.gpus.length}, ueHost=${conn.ueHost})`);
		this.emit("online", conn);
		this.emit("changed");
	}

	onMessage(conn, msg) {
		if (conn.rejected) return; // 因机器 ID 冲突被拒绝、正在断开的连接
		switch (msg.type) {
			case "hello":
				return this.register(conn, msg);
			case "stats":
				if (!conn.ready) return;
				conn.cpu = msg.cpu ?? conn.cpu;
				conn.memUsedMB = msg.memUsedMB ?? conn.memUsedMB;
				if (Array.isArray(msg.gpus)) conn.gpus = msg.gpus;
				conn.procs = Array.isArray(msg.procs) ? msg.procs : [];
				conn.lastStatsAt = Date.now();
				this.emit("stats", conn);
				this.emit("changed");
				return;
			case "started":
			case "exited":
			case "error":
				if (!msg.instanceId) return;
				this.emit(msg.type, conn, msg);
				return;
		}
	}

	detach(conn) {
		if (this.agents.get(conn.machineId) !== conn) return;
		this.agents.delete(conn.machineId);
		this.log.warn(`[agents] ${conn.machineId} 离线`);
		this.emit("offline", conn);
		this.emit("changed");
	}

	snapshot() {
		const machines = this.store.listMachines();
		return machines.map((m) => {
			const a = this.agents.get(m.id);
			return {
				id: m.id,
				name: m.name,
				host: m.host,
				enabled: m.enabled,
				max_instances: m.max_instances,
				tags: m.tags,
				online: !!a?.ready,
				local: !!a?.local,
				legacy: !!a?.legacy,
				platform: a?.platform || m.info.platform,
				version: a?.version || m.info.version,
				cpus: a?.cpus || m.info.cpus,
				cpu: a?.cpu ?? null,
				memUsedMB: a?.memUsedMB ?? null,
				memTotalMB: a?.memTotalMB || m.info.memTotalMB || null,
				gpus: a?.gpus?.length ? a.gpus : m.gpus_override?.length ? m.gpus_override.map((g) => ({ ...g, manual: true })) : m.info.gpus || [],
				gpus_override: m.gpus_override || [],
				procs: a?.procs || [],
				last_seen_at: a ? a.lastStatsAt : m.last_seen_at,
			};
		});
	}
}

function sanitizeId(id) {
	const s = String(id || "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.slice(0, 48);
	return s || null;
}

/** 旧版 exec-ue：下发拼好的命令字符串（Windows start 命令；参数加引号防空格） */
function legacyCommand({ exe, args = [] }) {
	const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
	return process.platform === "win32" || /^[a-z]:\\/i.test(exe) ? `start "" ${q(exe)} ${args.map(q).join(" ")}` : `${q(exe)} ${args.map(q).join(" ")} &`;
}

module.exports = { AgentHub, legacyCommand };
