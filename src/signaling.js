"use strict";
/**
 * 信令层：观众（peer-stream 子协议）、UE（无子协议）、Agent（ps-agent / 旧版 exec-ue）三类 WebSocket。
 * 协议与原版 peer-stream / UE 像素流插件兼容；调度决策全部交给 scheduler。
 */
const WS = require("ws");
const WebSocketServer = WS.WebSocketServer || WS.Server;
const { newId, normalizeIp, isPrivateIp, resolveRequestHost, ipInList } = require("./util.js");
const { buildIceServers, normalizeServers } = require("../lib/turn-tcp.js");
const { verifyJwt, parseCookies, hasRole } = require("./auth.js");

const crypto = require("crypto");

const UE_READY_TIMEOUT_MS = 1500;
const HEARTBEAT_MS = 30 * 1000;
const PLAYER_MSG_PER_SEC = 200; // 单个观众每秒最多转发的信令消息数（超出丢弃）
const PLAYER_MSG_ABUSE = 1000; // 每秒超过该值视为滥用，断开连接

class Signaling {
	constructor({ config, store, scheduler, agents, settings, secrets, log, limiter }) {
		this.limiter = limiter; // RateLimiter（可选）
		this.config = config;
		this.store = store;
		this.scheduler = scheduler;
		this.agents = agents;
		this.settings = settings; // () => 运行期设置（turn/ice/forceRelay…）
		this.secrets = secrets;
		this.log = log;
		this.players = new Map(); // id -> player
		this.linkSeen = new Map(); // 分享链接 ID -> 已计过次数的来源 IP（同一观众刷新/断线重连不重复消耗次数）
		this.playerSeq = 100;

		this.PLAYER = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 256 * 1024, perMessageDeflate: false });
		this.ENGINE = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 4 << 20, perMessageDeflate: false });
		this.AGENT = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 1 << 20, perMessageDeflate: false });

		this.bindSchedulerEvents();
		this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	close() {
		clearInterval(this.heartbeat);
		for (const wss of [this.PLAYER, this.ENGINE, this.AGENT]) for (const ws of wss.clients) ws.terminate();
	}

	/* -------------------------------------------------------- 客户端信息 */

	clientInfo(req, isPublic) {
		if (req._ps) return req._ps;
		const sec = this.config.security;
		const peer = normalizeIp(req.socket.remoteAddress);
		let ip = peer;
		let proxied = isPublic;
		const trusted = isPublic || (sec.trustProxy || []).map(normalizeIp).includes(peer);
		if (trusted) {
			const xff = String(req.headers["x-forwarded-for"] || "")
				.split(",")
				.map((s) => normalizeIp(s.trim()))
				.filter(Boolean);
			const xri = req.headers["x-real-ip"];
			if (xff.length) {
				ip = xff[xff.length - 1];
				for (let i = xff.length - 1; i >= 0; i--) {
					ip = xff[i];
					if (!(sec.trustProxy || []).map(normalizeIp).includes(ip)) break;
				}
				proxied = true;
			} else if (xri) {
				ip = normalizeIp(String(xri).trim());
				proxied = true;
			}
		}
		const external = proxied && !isPrivateIp(ip, sec.lanNetworks || []);
		const where = proxied ? resolveRequestHost(req.headers, !!req.socket.encrypted) : null;
		return (req._ps = { ip, proxied, external, where, isPublic });
	}

	engineAllowed(req, isPublic) {
		const info = this.clientInfo(req, isPublic);
		if (isPublic || info.proxied) return false;
		const ok = ipInList(this.config.security.engineAllow, info.ip);
		return ok === null ? true : ok;
	}

	/** 管理员会话（管理端预览播放时可免分享令牌） */
	adminFromReq(req) {
		const tok = parseCookies(req.headers.cookie).ps_session;
		const claims = tok ? verifyJwt(tok, this.secrets.jwt) : null;
		if (!claims || claims.typ !== "session") return null;
		// 与管理端一致：用户被禁用 / 改口令 / 强制下线后，会话立即失效
		const u = this.store.getUser(claims.sub);
		if (!u || u.disabled || (u.token_version || 0) !== (claims.tv || 0)) return null;
		return hasRole(u.role, "viewer") ? claims : null;
	}

	/* -------------------------------------------------------- 升级分发 */

	handleUpgrade(req, socket, head, isPublic) {
		socket.on("error", () => {});
		const protocols = String(req.headers["sec-websocket-protocol"] || "")
			.split(",")
			.map((s) => s.trim());
		const reject = (code, text) => {
			try {
				socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			} catch {}
			socket.destroy();
		};
		const info = this.clientInfo(req, isPublic);

		if (protocols.includes("peer-stream")) {
			// 防连接洪泛：只限制观众连接（UE / Agent 已由网段白名单 + 令牌约束，且同一渲染机上的多个 UE 共用一个 IP）
			const rl = this.settings().security?.rateLimit || {};
			if (this.limiter && !this.limiter.allow(`ws:${info.ip}`, +rl.wsPerSec || 0, +rl.wsBurst || 100)) return reject(429, "Too Many Requests");
			const max = this.settings().maxPlayersPerIp || this.config.security.maxPlayersPerIp;
			if (max > 0 && [...this.players.values()].filter((p) => p.ip === info.ip).length >= max) return reject(429, "Too Many Requests");
			return this.PLAYER.handleUpgrade(req, socket, head, (ws) => this.onPlayer(ws, req, info));
		}
		if (!this.engineAllowed(req, isPublic)) {
			this.log.warn(`[signal] 拒绝来自 ${info.ip} 的 ${protocols[0] || "UE"} 连接${isPublic ? "（玩家口）" : ""}`);
			return reject(403, "Forbidden");
		}
		const url = new URL(req.url, "http://x");
		if (protocols.includes("ps-agent")) {
			if (!tokenEqual(url.searchParams.get("token"), this.secrets.agentToken)) {
				this.log.warn(`[signal] Agent 令牌错误，来自 ${info.ip}`);
				return reject(401, "Unauthorized");
			}
			return this.AGENT.handleUpgrade(req, socket, head, (ws) => this.agents.attachWs(ws, { id: url.searchParams.get("id"), ip: info.ip, ueHost: req.headers.host }));
		}
		if (protocols.includes("exec-ue")) {
			if (url.pathname.endsWith("admin")) return reject(410, "Gone"); // 旧版管理页的日志通道已由管理端取代
			return this.AGENT.handleUpgrade(req, socket, head, (ws) => this.agents.attachWs(ws, { ip: info.ip, ueHost: req.headers.host, legacy: true }));
		}
		return this.ENGINE.handleUpgrade(req, socket, head, (ws) => this.onUe(ws, req, info));
	}

	/* -------------------------------------------------------- ICE */

	iceConfigFor(player) {
		const s = this.settings();
		const t = s.turn || {};
		const iceServers = buildIceServers(normalizeServers(t), { scope: "player", external: player.external, ...(player.where || {}), ttl: t.ttl, user: `p${player.id}` });
		const hasTurn = (srv) => [].concat(srv?.urls || []).some((u) => /^turns?:/i.test(u));
		const mode = t.forceRelay === "proxied" ? "external" : t.forceRelay;
		let force = mode === true || (mode === "external" && player.external);
		for (const srv of s.iceServers || []) if (!force || hasTurn(srv)) iceServers.push(srv);
		if (force && !iceServers.some(hasTurn)) force = false;
		return { type: "seticeServers", iceServers, iceTransportPolicy: force ? "relay" : "all", qos: 5000 };
	}

	ueIceServers() {
		const s = this.settings();
		const t = s.turn || {};
		return [...(s.ueIceServers || s.iceServers || []), ...buildIceServers(normalizeServers(t), { scope: "ue", ueTtl: t.ueTtl, user: "ue" })];
	}

	/* -------------------------------------------------------- 观众 */

	resolveProgramId(req) {
		const url = new URL(req.url, "http://x");
		const q = url.searchParams.get("program") || url.searchParams.get("urlPrefix");
		if (q) return q;
		const seg = url.pathname.split("/").filter(Boolean);
		if (seg[0] === "play" && seg[1]) return decodeURIComponent(seg[1]);
		if (seg[0] && !seg[0].includes(".")) return decodeURIComponent(seg[0]);
		return null;
	}

	checkToken(req, program, info) {
		if (!program.require_token) return { ok: true };
		if (this.adminFromReq(req) && !info.isPublic) return { ok: true, admin: true };
		const token = new URL(req.url, "http://x").searchParams.get("token");
		const c = token ? verifyJwt(token, this.secrets.jwt) : null;
		if (!c || c.typ !== "share") return { ok: false, reason: "需要有效的访问链接" };
		if (c.pid !== program.id) return { ok: false, reason: "访问链接与程序不匹配" };
		const link = this.store.getShareLink(c.lid);
		if (!link || link.revoked) return { ok: false, reason: "访问链接已失效" };
		if (link.expires_at && link.expires_at < Date.now()) return { ok: false, reason: "访问链接已过期" };
		let seen = this.linkSeen.get(link.id);
		if (seen?.has(info.ip)) return { ok: true, linkId: link.id };
		if (link.max_uses && link.uses >= link.max_uses) return { ok: false, reason: "访问链接使用次数已用完" };
		this.store.useShareLink(link.id);
		if (!seen) {
			if (this.linkSeen.size > 5000) this.linkSeen.delete(this.linkSeen.keys().next().value);
			this.linkSeen.set(link.id, (seen = new Set()));
		}
		if (seen.size < 10000) seen.add(info.ip);
		return { ok: true, linkId: link.id };
	}

	onPlayer(ws, req, info) {
		const rt = this.scheduler.resolveProgram(this.resolveProgramId(req));
		const p = {
			id: String(++this.playerSeq),
			ws,
			ip: info.ip,
			external: info.external,
			proxied: info.proxied,
			where: info.where,
			userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
			programId: rt?.def.id || null,
			instance: null,
			queuePos: 0,
			joinedAt: Date.now(),
			assignedAt: 0,
			sessionId: null,
			linkId: null,
			isAlive: true,
			closed: false,
			msgSec: 0,
			msgCount: 0,
			qos: { n: 0, kbps: 0, rtt: 0, fps: 0, last: null },
		};
		ws.on("error", () => {});
		if (!rt) {
			safeSend(ws, "! 未找到对应的程序，请检查访问地址");
			return ws.close(4004, "program not found");
		}
		// 观众 IP 白名单：全局 + 程序级（任一配置了就必须命中）
		const globalAllow = this.settings().security?.viewerAllow || [];
		for (const list of [globalAllow, rt.def.allow_ips || []]) {
			if (list.length && !ipInList(list, info.ip)) {
				this.log.warn(`[signal] 拒绝观众 ${info.ip}：不在白名单内（程序 ${rt.def.id}）`);
				safeSend(ws, "! 当前网络不允许访问该内容");
				return ws.close(4006, "ip not allowed");
			}
		}
		const tok = this.checkToken(req, rt.def, info);
		if (!tok.ok) {
			safeSend(ws, `! ${tok.reason}`);
			return ws.close(4003, "token required");
		}
		p.linkId = tok.linkId || null;
		// 同一 IP 只保留最新会话（企业版 strictMatchIP 的等价功能）
		if (rt.def.one_session_per_ip) {
			for (const old of this.players.values()) {
				if (old.ip === p.ip && old.programId === p.programId) {
					safeSend(old.ws, "! 同一网络地址已在其它页面打开，本页面已断开");
					try {
						old.ws.close(4005, "replaced");
					} catch {}
				}
			}
		}
		this.players.set(p.id, p);

		ws.on("pong", () => (p.isAlive = true)); // 协议级心跳：兼容不回应用层 pong 的旧版 SDK
		ws.on("message", (data) => this.onPlayerMessage(p, data));
		ws.on("close", () => {
			p.closed = true;
			this.players.delete(p.id);
			this.scheduler.leave(p, "closed");
		});
		safeSend(ws, this.iceConfigFor(p));
		safeSend(ws, { type: "playerConfig", program: rt.def.id, name: rt.def.name, hideCursor: !!rt.def.hide_cursor, inactiveReleaseSec: rt.def.inactive_release_sec || 0 });
		// 无操作自动释放：SDK 收到后会在心跳时检测最近一次键鼠/触摸时间，超时回传 mouseRelease
		if (rt.def.inactive_release_sec > 0) safeSend(ws, { type: "setmouseReleaseTime", mouseReleaseTime: rt.def.inactive_release_sec });
		this.scheduler.join(p);
	}

	onPlayerMessage(p, data) {
		p.isAlive = true;
		const sec = Math.floor(Date.now() / 1000);
		if (sec !== p.msgSec) {
			p.msgSec = sec;
			p.msgCount = 0;
		}
		if (++p.msgCount > PLAYER_MSG_PER_SEC) {
			if (p.msgCount > PLAYER_MSG_ABUSE) {
				this.log.warn(`[signal] 观众 ${p.id}(${p.ip}) 信令消息洪泛，断开`);
				try {
					p.ws.close(1008, "message flood");
				} catch {}
			}
			return;
		}
		const msg = parseJson(data);
		if (!msg || typeof msg.type !== "string") return;
		switch (msg.type) {
			case "pong":
				p.isAlive = true;
				return;
			case "stats":
				return this.ingestQos(p, msg);
			case "mouseRelease": {
				const def = this.scheduler.programs.get(p.programId)?.def;
				if (!def?.inactive_release_sec) return;
				this.log.info(`[signal] 观众 ${p.id}(${p.ip}) 超过 ${def.inactive_release_sec}s 无操作，释放资源`);
				safeSend(p.ws, "! 长时间未操作，已自动断开以释放资源，刷新页面可重新进入");
				try {
					p.ws.close(4002, "inactive");
				} catch {}
				return;
			}
			case "offer":
			case "answer":
			case "iceCandidate": {
				const ue = p.instance?.ue;
				if (!ue) return safeSend(p.ws, "! Engine not ready");
				msg.playerId = p.id;
				return safeSend(ue, msg);
			}
			default:
				return; // getStatus 等企业版扩展消息忽略（播放质量已由 stats 主动上报）
		}
	}

	ingestQos(p, m) {
		const num = (v) => (Number.isFinite(+v) ? +v : null);
		const last = {
			kbps: num(m.kbps),
			fps: num(m.fps),
			rtt: num(m.rtt),
			lost: num(m.lost),
			w: num(m.w),
			h: num(m.h),
			transport: typeof m.transport === "string" ? m.transport.slice(0, 40) : null,
			at: Date.now(),
		};
		p.qos.last = last;
		if (last.kbps !== null) {
			p.qos.n++;
			p.qos.kbps += last.kbps;
			p.qos.rtt += last.rtt || 0;
			p.qos.fps += last.fps || 0;
		}
	}

	kick(playerId, reason = "kicked by admin") {
		const p = this.players.get(String(playerId));
		if (!p) return false;
		safeSend(p.ws, `! ${reason}`);
		try {
			p.ws.close(4001, "kicked");
		} catch {}
		return true;
	}

	/* -------------------------------------------------------- 调度事件 → 消息 */

	bindSchedulerEvents() {
		const s = this.scheduler;
		s.on("assigned", (p, inst) => {
			p.assignedAt = Date.now();
			safeSend(p.ws, this.iceConfigFor(p)); // 每次分配刷新 TURN 临时凭据
			const playerConnected = { type: "playerConnected", playerId: p.id, dataChannel: true, sfu: false };
			if (inst.ueVersion === "4.27") safeSend(p.ws, playerConnected);
			else safeSend(inst.ue, playerConnected);
			this.startSession(p, inst);
		});
		s.on("queued", (p, position) => safeSend(p.ws, { type: "playerqueue", seq: position }));
		s.on("released", (p, inst, reason) => {
			if (inst.ue) safeSend(inst.ue, { type: "playerDisconnected", playerId: p.id });
			this.endSession(p, inst, reason);
		});
		s.on("ueLost", (p, inst) => {
			safeSend(p.ws, { type: "ueDisConnected" });
			this.endSession(p, inst, "ue lost");
		});
		s.on("rejected", (p, reason) => {
			safeSend(p.ws, `! ${reason}`);
			try {
				p.ws.close(4000, "rejected");
			} catch {}
		});
	}

	startSession(p, inst) {
		p.sessionId = newId(12);
		p.qos = { n: 0, kbps: 0, rtt: 0, fps: 0, last: null };
		try {
			this.store.startSession({
				id: p.sessionId,
				program_id: p.programId,
				instance_id: inst.id,
				machine_id: inst.machineId,
				client_ip: p.ip,
				external: p.external,
				user_agent: p.userAgent,
				share_link_id: p.linkId,
			});
		} catch (e) {
			this.log.error("[signal] 会话记录失败", e.message);
		}
	}

	endSession(p, inst, reason) {
		if (!p.sessionId) return;
		const q = p.qos;
		try {
			this.store.endSession(p.sessionId, {
				end_reason: reason,
				avg_kbps: q.n ? Math.round(q.kbps / q.n) : null,
				avg_rtt_ms: q.n ? Math.round(q.rtt / q.n) : null,
				avg_fps: q.n ? +(q.fps / q.n).toFixed(1) : null,
				transport: q.last?.transport || null,
				instance_id: inst?.id,
				machine_id: inst?.machineId,
			});
		} catch (e) {
			this.log.error("[signal] 会话结束记录失败", e.message);
		}
		p.sessionId = null;
	}

	/* -------------------------------------------------------- UE */

	parseUePath(req) {
		const seg = new URL(req.url, "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
		if (seg[0] === "ue") return { programId: seg[1] || null, instanceId: seg[2] || null };
		return { programId: seg[0] || null, instanceId: null }; // 旧版：/ 、/<程序>、/<程序>/<任意>
	}

	onUe(ws, req, info) {
		ws.ip = info.ip;
		ws.isAlive = true;
		ws.on("pong", () => (ws.isAlive = true));
		ws.on("error", () => {});
		const { inst, reason, retired } = this.scheduler.ueConnected(ws, this.parseUePath(req));
		if (!inst) {
			this.log.warn(`[signal] 拒绝 UE 连接（${reason}）来自 ${info.ip}`);
			return ws.close(retired ? 4009 : 4004, retired ? "instance retired" : "unknown program");
		}
		const def = this.scheduler.programs.get(inst.programId)?.def || {};
		safeSend(ws, { type: "identify" });
		safeSend(ws, { type: "config", peerConnectionOptions: { iceServers: this.ueIceServers() }, protocolVersion: "1.1.0" });

		const ver = String(def.ue_version || "auto");
		const markReady = (detected) => {
			if (ws.readyState !== 1) return;
			if (detected) inst.ueVersion = detected;
			this.scheduler.ueReady(inst);
		};
		if (ver === "4.27") {
			inst.ueVersion = "4.27";
			markReady();
		} else if (ver !== "5.52") {
			// 像素流1 不回 endpointId：短暂等待后视为就绪；像素流2 会在此之前发 endpointId（auto 自动识别）
			inst.readyTimer = setTimeout(() => markReady("5"), UE_READY_TIMEOUT_MS);
		}

		ws.on("message", (data) => {
			const msg = parseJson(data);
			if (!msg) return;
			if (msg.type === "ping") return safeSend(ws, { type: "pong", time: msg.time });
			if (msg.type === "endpointId") {
				safeSend(ws, { type: "endpointIdConfirm", committedId: msg.id });
				clearTimeout(inst.readyTimer);
				return markReady("5.52");
			}
			const p = this.players.get(String(msg.playerId));
			if (!p || p.instance !== inst) return;
			delete msg.playerId;
			if (msg.type === "offer" || msg.type === "answer" || msg.type === "iceCandidate") safeSend(p.ws, msg);
			else if (msg.type === "disconnectPlayer") {
				try {
					p.ws.close(1011, truncateReason(msg.reason));
				} catch {}
			}
		});
		ws.on("close", () => {
			clearTimeout(inst.readyTimer);
			if (inst.ue === ws) this.scheduler.ueClosed(inst, "ue closed");
		});
	}

	/* -------------------------------------------------------- 心跳 */

	beat() {
		for (const p of this.players.values()) {
			if (p.isAlive === false) {
				p.ws.terminate();
				continue;
			}
			p.isAlive = false;
			safeSend(p.ws, { type: "ping" }); // 应用层 ping：SDK 回 pong，并借此检查"无操作自动释放"
			try {
				p.ws.ping();
			} catch {}
		}
		for (const wss of [this.ENGINE, this.AGENT]) {
			for (const ws of wss.clients) {
				if (ws.isAlive === false) {
					ws.terminate();
					continue;
				}
				ws.isAlive = false;
				try {
					ws.ping();
				} catch {}
			}
		}
	}

	livePlayers() {
		return [...this.players.values()].map((p) => ({
			id: p.id,
			programId: p.programId,
			instanceId: p.instance?.id || null,
			machineId: p.instance?.machineId || null,
			state: p.instance ? "playing" : "queued",
			queuePos: p.instance ? 0 : p.queuePos,
			ip: p.ip,
			external: p.external,
			userAgent: p.userAgent,
			joinedAt: p.joinedAt,
			assignedAt: p.assignedAt || null,
			qos: p.qos.last,
		}));
	}
}

function tokenEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || !b) return false;
	const h = (x) => crypto.createHash("sha256").update(x).digest();
	return crypto.timingSafeEqual(h(a), h(b));
}

function safeSend(ws, data) {
	if (!ws || ws.readyState !== 1) return false;
	try {
		ws.send(typeof data === "string" ? data : JSON.stringify(data));
		return true;
	} catch {
		return false;
	}
}

function parseJson(data) {
	try {
		return JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
	} catch {
		return null;
	}
}

function truncateReason(r) {
	let s = String(r ?? "");
	while (Buffer.byteLength(s) > 120) s = s.slice(0, -1);
	return s;
}

module.exports = { Signaling, safeSend };
