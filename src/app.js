"use strict";
/**
 * 应用装配：配置 → 存储 → 密钥/设置 → Agent 中心 → 调度器 → 信令 → TURN 子进程 → HTTP(S)（管理口 + 观众口）→ 实时推送/告警。
 * createApp() 返回可启动/停止的实例（测试中可同时创建多个）。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const child_process = require("child_process");
const { monitorEventLoopDelay } = require("perf_hooks");
const WS = require("ws");
const WebSocketServer = WS.WebSocketServer || WS.Server;

const { Store } = require("./store.js");
const { Settings, loadSecrets } = require("./settings.js");
const { ConfigCenter } = require("./config-center.js");
const { AgentHub } = require("./agents.js");
const { Scheduler } = require("./scheduler.js");
const { Signaling, safeSend, tokenEqual } = require("./signaling.js");
const { Metrics } = require("./metrics.js");
const { Router, sendJson, sendText, readJson, securityHeaders, serveFile, serveDownload, resolveSafe } = require("./http.js");
const { registerApi } = require("./api.js");
const { verifyJwt, parseCookies, hasRole, hashPassword, LoginLimiter } = require("./auth.js");
const { RateLimiter, parseApiToken, safeEqualHex } = require("./security.js");
const { Alerts } = require("./alerts.js");
const { createLogger } = require("./logger.js");
const { firstLanIPv4, ipInList, randomSecret, throttle } = require("./util.js");
const { createAgent } = require("../agent/agent.js");
const { AgentPackages, configSection } = require("./downloads.js");

const VERSION = "1.5.0";

function createApp({ config, assetsDir, log, selfCommand, env = process.env }) {
	const store = new Store(config.dataDir);
	// 配置中心：管理端维护的系统参数（环境变量 > 管理端保存 > 默认），在其它模块读取 config 之前写入生效值
	let configCenter;
	try {
		configCenter = new ConfigCenter({ store, config, env });
	} catch (e) {
		store.close();
		throw e;
	}
	log = log || createLogger({ level: config.log.level, dir: config.log.file ? path.join(config.dataDir, "logs") : null, retentionDays: config.log.retentionDays });
	for (const [lv, msg] of configCenter.notes) log[lv](msg);
	for (const k of configCenter.staleFileKeys()) log.warn(`[config] config.json 中的 ${k} 已不再生效（以管理端「系统设置 → 系统参数」为准），可从 config.json 中删除`);
	const secrets = loadSecrets(store, env);
	const settings = new Settings(store, secrets, config);
	const rateLimiter = new RateLimiter();
	const alerts = new Alerts({ settings: () => settings.get(), log });
	const agents = new AgentHub({ store, log });
	// 内置 TLS 默认只用于观众口；http.tls.admin=true 时管理口（UE/Agent 连接）也启用，UE 需使用 wss:// 且信任证书
	const adminTls = !!(config.http.tls && config.http.tls.admin);
	const proto = adminTls ? "wss" : "ws";
	const ueHost = config.gateway.ueHost && config.gateway.ueHost !== "auto" ? config.gateway.ueHost : `${firstLanIPv4()}:${config.http.port}`;
	const scheduler = new Scheduler({ store, agents, log, defaultUeHost: ueHost, ueProto: proto });
	const signaling = new Signaling({ config, store, scheduler, agents, settings: () => settings.get(), secrets, log, limiter: rateLimiter });
	const limiter = new LoginLimiter();
	// Agent 安装包（渲染机从「接入渲染机」中的地址直接下载）；平台以打包程序运行时可直接提供自身
	const packages = new AgentPackages({
		dir: path.join(config.dataDir, "downloads"),
		version: VERSION,
		selfExe: selfCommand && selfCommand.length === 1 ? selfCommand[0] : null,
		setupStub: path.join(assetsDir, "agent-setup", "ps-agent-setup-stub.exe"),
		releaseBaseUrl: config.downloads?.releaseBaseUrl || "",
		log,
	});
	const loopDelay = monitorEventLoopDelay({ resolution: 20 });
	loopDelay.enable();
	let turnProc = null;
	let turnStats = null;
	let stopping = false;
	const servers = [];
	const timers = [];

	/* ---------------------------------------------------- 首次运行 */
	store.closeDanglingSessions();
	if (store.countUsers() === 0) {
		const password = env.PS_ADMIN_PASSWORD || randomSecret(6) + "A1";
		const u = store.createUser({ username: "admin", password_hash: hashPassword(password), role: "admin" });
		store.setSetting(`mustChange:${u.id}`, !env.PS_ADMIN_PASSWORD);
		if (!env.PS_ADMIN_PASSWORD) {
			const f = path.join(config.dataDir, "initial-admin.txt");
			fs.writeFileSync(f, `用户名: admin\n初始口令: ${password}\n首次登录后请立即修改口令，然后删除本文件。\n`, { mode: 0o600 });
			log.warn(`[app] 已创建管理员 admin，初始口令见 ${f}`);
		}
	}
	if (store.listPrograms().length === 0) {
		store.createProgram({ id: "default", name: "默认程序", description: "手动启动的 UE（-PixelStreamingURL=ws://平台:端口/）会加入这里", mode: "shared", max_viewers: 10, max_instances: 10 });
		scheduler.loadPrograms();
	}
	fs.mkdirSync(config.site.dir, { recursive: true });

	/* ---------------------------------------------------- 指标 */
	const metrics = new Metrics({
		sample: () => {
			const snap = scheduler.snapshot();
			const players = [...signaling.players.values()];
			const online = agents.online();
			const gpus = online.flatMap((a) => a.gpus || []);
			return {
				viewers: players.filter((p) => p.instance).length,
				external: players.filter((p) => p.external).length,
				queued: players.filter((p) => !p.instance).length,
				instancesActive: snap.instances.filter((i) => i.state !== "stopping").length,
				instancesBusy: snap.instances.filter((i) => i.state === "busy").length,
				agentsOnline: online.length,
				gpuUtil: gpus.length ? Math.round(gpus.reduce((s, g) => s + (g.util || 0), 0) / gpus.length) : 0,
				cpu: online.length ? Math.round(online.reduce((s, a) => s + (a.cpu || 0), 0) / online.length) : 0,
				turnBytes: turnStats ? turnStats.bytesDown + turnStats.bytesUp : null,
				turn: turnStats,
				programs: snap.programs,
				loopDelayMs: Math.round(loopDelay.percentile(99) / 1e6),
			};
		},
	});
	signaling.PLAYER.on("connection", () => metrics.inc("playersTotal"));

	/* ---------------------------------------------------- 告警 */
	agents.on("offline", (a) => alerts.notify("agent.offline", `渲染机 ${a.machineId}（${a.ip}）已离线`, { key: a.machineId }));
	agents.on("online", (a) => alerts.notify("agent.online", `渲染机 ${a.machineId}（${a.ip}）已上线`, { key: a.machineId }));
	agents.on("conflict", (a, prev) => alerts.notify("agent.conflict", `机器 ID「${a.machineId}」已被 ${prev.local ? "平台内置的本机 Agent" : prev.ip} 使用，已拒绝 ${a.ip} 的接入，请为该渲染机换一个机器名称`, { key: `${a.machineId}:${a.ip}` }));
	scheduler.on("removed", (inst, reason) => {
		if (!String(reason).startsWith("failed")) return;
		metrics.inc("instancesFailed");
		alerts.notify("instance.failed", `程序 ${inst.programId} 的实例 ${inst.id} 在 ${inst.machineId} 启动失败：${String(reason).replace(/^failed: /, "")}`, { key: inst.programId });
	});
	scheduler.on("warning", (text) => alerts.notify("program.capacity", text, { key: text }));
	const backlogSince = new Map();
	timers.push(
		setInterval(() => {
			const limit = (settings.get().alerts?.queueBacklogSec || 60) * 1000;
			for (const rt of scheduler.programs.values()) {
				if (!rt.queue.length) {
					backlogSince.delete(rt.def.id);
					continue;
				}
				if (!backlogSince.has(rt.def.id)) backlogSince.set(rt.def.id, Date.now());
				if (Date.now() - backlogSince.get(rt.def.id) > limit) alerts.notify("queue.backlog", `程序 ${rt.def.name}（${rt.def.id}）已有 ${rt.queue.length} 位观众排队超过 ${Math.round(limit / 1000)} 秒`, { key: rt.def.id });
			}
		}, 15000)
	);

	/* ---------------------------------------------------- 内置本机 Agent */
	if (config.localAgent.enable) agents.attachLocal(createAgent, { machineId: "local", ueHost, allowExe: config.localAgent.allowExe || [], stateFile: path.join(config.dataDir, "local-agent-state.json") });

	/* ---------------------------------------------------- TURN 子进程 */
	function startTurn() {
		const b = config.turn.builtin;
		const conf = { ...b, secret: secrets.turn };
		delete conf.enable;
		const [cmd, ...args] = selfCommand;
		turnProc = child_process.spawn(cmd, [...args, "--turn"], {
			env: { ...process.env, TURN_CONFIG_JSON: JSON.stringify(conf) },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			windowsHide: true,
		});
		log.pipe(turnProc.stdout, "[turn]");
		log.pipe(turnProc.stderr, "[turn]", "warn");
		const started = Date.now();
		turnProc.on("message", (m) => m?.type === "turn-stats" && (turnStats = { ...m.stats, at: Date.now() }));
		turnProc.on("exit", (code, signal) => {
			turnProc = null;
			turnStats = null;
			if (stopping) return;
			startTurn.retries = Date.now() - started > 60000 ? 0 : (startTurn.retries || 0) + 1;
			const delay = Math.min(30, 2 ** startTurn.retries) * 1000;
			log.error(`[app] 内置 TURN 退出（${signal || code}），${delay / 1000}s 后重启`);
			alerts.notify("turn.down", `内置 TURN 进程退出（${signal || code}），${delay / 1000} 秒后自动重启`);
			timers.push(setTimeout(startTurn, delay));
		});
	}

	/* ---------------------------------------------------- 概览数据 */
	function overview({ withSeries = true } = {}) {
		const snap = scheduler.snapshot();
		const players = signaling.livePlayers();
		const machines = agents.snapshot();
		const online = machines.filter((m) => m.online);
		const gpus = online.flatMap((m) => m.gpus || []);
		const last = metrics.fine.items[metrics.fine.items.length - 1];
		return {
			at: Date.now(),
			kpis: {
				viewers: players.filter((p) => p.state === "playing").length,
				external: players.filter((p) => p.external).length,
				queued: players.filter((p) => p.state === "queued").length,
				instances: {
					active: snap.instances.filter((i) => i.state !== "stopping").length,
					busy: snap.instances.filter((i) => i.state === "busy").length,
					idle: snap.instances.filter((i) => i.state === "idle").length,
					starting: snap.instances.filter((i) => i.state === "starting").length,
				},
				machines: { online: online.length, total: machines.length },
				gpu: { count: gpus.length, util: gpus.length ? Math.round(gpus.reduce((s, g) => s + (g.util || 0), 0) / gpus.length) : null, memUsedMB: gpus.reduce((s, g) => s + (g.memUsedMB || 0), 0), memTotalMB: gpus.reduce((s, g) => s + (g.memTotalMB || 0), 0) },
				turn: turnStats ? { up: true, workers: turnStats.workers, allocations: turnStats.allocations, kbps: last?.turnKbps || 0, dropped: turnStats.dropped } : { up: false, enabled: !!config.turn.builtin.enable },
			},
			programs: snap.programs,
			instances: snap.instances,
			machines,
			players: players.slice(0, 500),
			series: withSeries ? metrics.series("1h") : undefined,
			config: { rev: configCenter.meta.rev, pendingRestart: configCenter.pendingCount(), pendingGroups: configCenter.pendingGroups() },
		};
	}

	function systemInfo() {
		return {
			version: VERSION,
			node: process.version,
			platform: `${process.platform} ${process.arch}`,
			pid: process.pid,
			uptime: Math.round(process.uptime()),
			memoryMB: Math.round(process.memoryUsage().rss / 1048576),
			loopDelayMs: Math.round(loopDelay.percentile(99) / 1e6),
			ports: { admin: config.http.port, public: config.http.publicPort, tls: config.http.tls ? (adminTls ? "both" : "public") : "none" },
			ueHost: `${proto}://${ueHost}`,
			dataDir: config.dataDir,
			siteDir: config.site.dir,
			logDir: log.dir || null,
			turn: { enabled: !!config.turn.builtin.enable, running: !!turnProc, stats: turnStats },
		};
	}

	// 系统参数立即生效的项：config 已由配置中心就地更新，这里处理需要通知到对象内部的项
	configCenter.on("change", ({ key, value }) => {
		if (key === "log.level") log.setLevel?.(value);
		else if (key === "log.retentionDays") log.setRetentionDays?.(value);
		else if (key === "downloads.releaseBaseUrl") packages.releaseBaseUrl = value;
	});
	configCenter.on("saved", ({ changes, rev }) => {
		log.info(`[config] 系统参数已更新（版本 ${rev}）：${changes.map((c) => `${c.key}${c.apply === "restart" ? "（重启后生效）" : ""}`).join("、")}`);
		broadcastConfig();
	});

	const ctx = { store, scheduler, agents, signaling, metrics, settings, secrets, config, configCenter, limiter, alerts, log, overview, systemInfo, packages, version: VERSION };
	const router = new Router();
	registerApi(router, ctx);

	/* ---------------------------------------------------- 身份 */
	function adminAllowed(req, isPublic) {
		if (isPublic) return false;
		const info = signaling.clientInfo(req, false);
		const ok = ipInList(config.security.adminAllow, info.ip);
		return ok === null ? !info.proxied : ok;
	}
	const tokenTouch = new Map();
	/** 当前用户：Bearer API 令牌 或 会话 Cookie（会话需与用户的 token_version 一致，改口令/禁用后立即失效） */
	function currentUser(req) {
		const auth = String(req.headers.authorization || "");
		if (auth.startsWith("Bearer ")) {
			const p = parseApiToken(auth.slice(7).trim());
			const t = p && store.getApiToken(p.id);
			if (!t || t.revoked || (t.expires_at && t.expires_at < Date.now()) || !safeEqualHex(t.token_hash, p.hash)) return null;
			if (Date.now() - (tokenTouch.get(t.id) || 0) > 60000) {
				tokenTouch.set(t.id, Date.now());
				store.touchApiToken(t.id);
			}
			return { id: `token:${t.id}`, username: `token:${t.name}`, role: t.role, token: true };
		}
		const claims = verifyJwt(parseCookies(req.headers.cookie).ps_session, secrets.jwt);
		if (!claims || claims.typ !== "session") return null;
		const u = store.getUser(claims.sub);
		if (!u || u.disabled || (u.token_version || 0) !== (claims.tv || 0)) return null;
		return { id: u.id, username: u.username, role: u.role };
	}
	ctx.currentUser = currentUser;

	/* ---------------------------------------------------- 请求处理 */
	const publicDir = path.join(assetsDir, "public");
	const playerPage = (req, res) => serveFile(req, res, publicDir, "/player.html");
	const siteHas = (p) => {
		const f = resolveSafe(config.site.dir, p);
		if (!f) return false;
		try {
			return fs.statSync(f).isFile();
		} catch {
			return false;
		}
	};

	function cors(req, res) {
		const origin = req.headers.origin;
		if (!origin) return false;
		const allowed = settings.get().security?.corsOrigins || [];
		if (!allowed.includes("*") && !allowed.includes(origin)) return false;
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-PS-Request");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
		res.setHeader("Access-Control-Max-Age", "600");
		return true;
	}

	/* ---------------------------------------------------- Agent 安装包 */
	const NOT_READY = "该安装包尚未提供：请管理员在管理端「渲染机 / GPU → 接入渲染机」中上传或从发布页获取。\n";
	function agentDownload(req, res, p, url) {
		if (p === "/agent/check") {
			// 安装向导「检测连接」：令牌正确时返回平台版本（限速，防止猜测令牌）
			if (!rateLimiter.allow(`agentcheck:${req.clientIp}`, 2, 10)) return sendJson(res, 429, { error: "请求过于频繁，请稍后再试" });
			if (!tokenEqual(String(req.headers["x-agent-token"] || ""), secrets.agentToken)) return sendJson(res, 401, { error: "接入令牌不正确" });
			return sendJson(res, 200, { ok: true, version: VERSION });
		}
		const name = p.slice("/download/agent/".length).replace(/\/+$/, "");
		if (name === "windows-setup") {
			// 管理端生成的安装链接（24 小时有效）：安装程序末尾附加平台地址与当前接入令牌，渲染机上双击按「下一步」即可
			const claims = verifyJwt(url.searchParams.get("k"), secrets.jwt);
			if (!claims || claims.typ !== "agent-setup" || !claims.ws) return sendText(res, 403, "安装链接无效或已过期（24 小时内有效）：请在管理端「接入渲染机」中重新复制。\n");
			const f = packages.resolve("windows");
			if (!f) return sendText(res, 404, NOT_READY);
			const append = configSection({ v: 1, url: claims.ws, token: secrets.agentToken, platform: claims.http, version: VERSION });
			if (req.method === "GET") store.audit({ username: claims.by || "", ip: req.clientIp, action: "agent.setup_download", target: "windows" });
			return serveDownload(req, res, f.path, "ps-platform-agent-setup.exe", { append });
		}
		if (name === "windows-exe") {
			// 命令行方式使用的 Agent 程序本身：平台自身或从安装程序中解压
			const f = packages.resolveWindowsExe();
			if (!f) return sendText(res, 404, NOT_READY);
			return serveDownload(req, res, f.path, "ps-platform.exe", { gzip: f.gzip, size: f.size });
		}
		const f = packages.resolve(name); // windows：未附带配置的安装程序（向导中手动填写地址与令牌）；linux：Agent 程序
		if (!f) return sendText(res, 404, NOT_READY);
		return serveDownload(req, res, f.path, f.file);
	}

	async function onRequest(req, res, isPublic) {
		let url;
		try {
			url = new URL(req.url, "http://x");
		} catch {
			return sendText(res, 400, "Bad Request");
		}
		const p = url.pathname;
		req.clientIp = signaling.clientInfo(req, isPublic).ip;
		securityHeaders(res, { admin: !isPublic && (p.startsWith("/admin") || p.startsWith("/api/")) });
		try {
			if (p === "/healthz") {
				const lag = Math.round(loopDelay.percentile(99) / 1e6);
				const status = lag > 1000 ? "degraded" : "ok";
				return sendJson(res, 200, isPublic ? { status } : { status, version: VERSION, uptime: Math.round(process.uptime()), loopDelayMs: lag, viewers: signaling.players.size, instances: scheduler.instances.size, agents: agents.online().length, turn: turnStats ? "up" : config.turn.builtin.enable ? "down" : "disabled" });
			}
			if (p.startsWith("/api/")) return await onApi(req, res, url, isPublic);
			if (p === "/metrics") {
				if (!adminAllowed(req, isPublic)) return sendText(res, 403, "Forbidden");
				return sendText(res, 200, metrics.prometheus({ turnEnabled: config.turn.builtin.enable }), "text/plain; version=0.0.4");
			}
			if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method Not Allowed");
			// Agent 安装包下载与令牌校验：只在管理口，且来自管理网段或 UE/Agent 网段（渲染机）
			if (!isPublic && (p.startsWith("/download/agent/") || p === "/agent/check")) {
				if (!adminAllowed(req, false) && !signaling.engineAllowed(req, false)) return sendText(res, 403, "Forbidden");
				return agentDownload(req, res, p, url);
			}
			if (!isPublic && (p === "/admin" || p.startsWith("/admin/"))) {
				if (!adminAllowed(req, false)) return sendText(res, 403, "Forbidden");
				const rel = p === "/admin" || p === "/admin/" ? "/index.html" : p.slice("/admin".length);
				return serveFile(req, res, path.join(assetsDir, "admin"), rel);
			}
			if (p === "/" || p === "/index.html") {
				if (!isPublic && adminAllowed(req, false) && !url.searchParams.has("portal")) {
					res.writeHead(302, { Location: "/admin/" });
					return res.end();
				}
				return serveFile(req, res, siteHas("/index.html") ? config.site.dir : publicDir, "/index.html");
			}
			if (p.startsWith("/play/") || p === "/player.html" || p === "/video.html") return playerPage(req, res);
			if (/^\/[a-z0-9][a-z0-9_-]{0,31}\/?$/i.test(p) && scheduler.programs.has(p.replace(/\//g, "").toLowerCase())) return playerPage(req, res); // 兼容 /<程序ID>（大小写不敏感）
			if (siteHas(p)) return serveFile(req, res, config.site.dir, p, { cache: "no-cache" }); // 自定义网页托管
			return serveFile(req, res, publicDir, p, { cache: "public, max-age=300" });
		} catch (e) {
			log.error("[http]", e);
			sendJson(res, e.status || 500, { error: e.status ? e.message : "服务器内部错误" });
		}
	}

	async function onApi(req, res, url, isPublic) {
		const corsOk = cors(req, res);
		if (req.method === "OPTIONS") {
			res.writeHead(corsOk ? 204 : 403);
			return res.end();
		}
		const rl = settings.get().security?.rateLimit || {};
		if (!rateLimiter.allow(`api:${req.clientIp}`, +rl.apiPerSec || 0, +rl.apiBurst || 60)) return sendJson(res, 429, { error: "请求过于频繁，请稍后再试" });
		const m = router.match(req.method, url.pathname);
		if (!m) return sendJson(res, 404, { error: "接口不存在" });
		if (m.methodNotAllowed) return sendJson(res, 405, { error: "方法不允许" });
		const { route, params } = m;
		const toolPublic = route.opts.tool && settings.get().security?.publicTools;
		const openRoute = route.opts.playerSafe || toolPublic;
		if (isPublic && !openRoute) return sendJson(res, 404, { error: "接口不存在" });
		if (!isPublic && !openRoute && !adminAllowed(req, false)) return sendJson(res, 403, { error: "当前网络不允许访问管理接口" });
		if (!route.opts.public && !toolPublic) {
			req.user = currentUser(req);
			if (!req.user) return sendJson(res, 401, { error: "未登录、登录已过期或 API 令牌无效" });
			if (!hasRole(req.user.role, route.opts.role || "admin")) return sendJson(res, 403, { error: "权限不足" });
			if (req.user.token && route.opts.noToken) return sendJson(res, 403, { error: "该接口不允许使用 API 令牌调用" });
			if (!req.user.token && route.opts.tokenOnly) return sendJson(res, 403, { error: "该接口只允许业务系统使用 API 令牌调用" });
		}
		// CSRF：基于 Cookie 的写操作必须带自定义头（跨站表单/图片无法附带）；Bearer 令牌不受 CSRF 影响
		const viaToken = String(req.headers.authorization || "").startsWith("Bearer ");
		if (req.method !== "GET" && !viaToken && !toolPublic && req.headers["x-ps-request"] !== "1") return sendJson(res, 403, { error: "缺少 X-PS-Request 请求头" });
		let body = {};
		try {
			if (req.method !== "GET" && !route.opts.rawBody) body = await readJson(req, route.opts.bodyLimit || 1 << 20); // rawBody：处理函数自行读取请求体（上传）
			await route.handler(req, res, { params, query: Object.fromEntries(url.searchParams), body });
		} catch (e) {
			if (!e.status) log.error("[api]", e);
			sendJson(res, e.status || 500, { error: e.status ? e.message : "服务器内部错误" });
		}
	}

	/* ---------------------------------------------------- 实时推送（管理端） */
	const EVENTS = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 4096 });
	const broadcast = throttle(() => {
		if (!EVENTS.clients.size) return;
		const data = JSON.stringify({ type: "overview", data: overview({ withSeries: false }) });
		for (const ws of EVENTS.clients) {
			// 管理会话失效（改口令/禁用/登出全部）后断开推送
			if (ws.readyState === 1 && ws.recheck && !currentUser(ws.req)) ws.close(4401, "session expired");
			else if (ws.readyState === 1) ws.send(data);
		}
	}, 1000);
	/** 系统参数变化：推送概览（含配置版本与待重启项数），其它管理员的页面据此提示刷新 */
	function broadcastConfig() {
		broadcast();
	}
	scheduler.on("changed", broadcast);
	agents.on("changed", broadcast);
	signaling.PLAYER.on("connection", (ws) => {
		broadcast();
		ws.on("close", broadcast);
	});
	timers.push(setInterval(broadcast, 5000)); // QoS 等无事件变化的数据定期刷新

	function onUpgrade(req, socket, head, isPublic) {
		const p = new URL(req.url, "http://x").pathname;
		if (!isPublic && p === "/api/v1/events") {
			const user = adminAllowed(req, false) && currentUser(req);
			if (!user) {
				socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
				return socket.destroy();
			}
			return EVENTS.handleUpgrade(req, socket, head, (ws) => {
				ws.req = req;
				ws.recheck = true;
				ws.on("error", () => {});
				safeSend(ws, { type: "overview", data: overview({ withSeries: false }) });
			});
		}
		signaling.handleUpgrade(req, socket, head, isPublic);
	}

	function certStamp() {
		try {
			return [config.http.tls.cert, config.http.tls.key].map((f) => fs.statSync(f).mtimeMs).join("/");
		} catch {
			return "";
		}
	}

	function listen(port, host, isPublic) {
		const handler = (req, res) => onRequest(req, res, isPublic);
		const useTls = config.http.tls && (isPublic || adminTls);
		const readCert = () => ({ cert: fs.readFileSync(config.http.tls.cert), key: fs.readFileSync(config.http.tls.key) });
		const srv = useTls ? https.createServer(readCert(), handler) : http.createServer(handler);
		if (useTls) {
			// 证书续期（acme.sh / certbot 等）后自动加载新证书，无需重启
			let stamp = certStamp();
			timers.push(
				setInterval(() => {
					const now = certStamp();
					if (!now || now === stamp) return;
					try {
						srv.setSecureContext(readCert());
						stamp = now;
						log.info("[app] 已加载更新后的 TLS 证书");
					} catch (e) {
						log.warn(`[app] 重新加载 TLS 证书失败：${e.message}`);
					}
				}, 60 * 1000)
			);
		}
		srv.on("upgrade", (req, socket, head) => onUpgrade(req, socket, head, isPublic));
		srv.on("clientError", (err, socket) => socket.destroy());
		srv.on("tlsClientError", () => {});
		// keepAliveTimeout 需大于 nginx upstream keepalive_timeout（默认 60s），否则 nginx 复用到刚被关闭的连接会偶发 502
		srv.headersTimeout = 20000;
		srv.requestTimeout = isPublic ? 60000 : 30 * 60000; // 管理口允许较长的上传（Agent 安装包约 100MB）；请求头仍须在 20 秒内到达
		srv.keepAliveTimeout = 65000;
		servers.push(srv);
		return new Promise((resolve, reject) => {
			srv.once("error", reject);
			srv.listen(port, host, () => {
				srv.off("error", reject);
				resolve(srv.address().port);
			});
		});
	}

	return {
		ctx,
		store,
		scheduler,
		signaling,
		agents,
		secrets,
		settings,
		log,
		ports: {},
		async start() {
			this.ports.admin = await listen(config.http.port, config.http.host, false);
			if (config.http.publicPort) this.ports.public = await listen(config.http.publicPort, config.http.publicHost, true);
			if (config.turn.builtin.enable) startTurn();
			timers.push(setInterval(() => store.purgeHistory(config.history.retentionDays || 90), 6 * 3600 * 1000));
			for (const t of timers) t.unref?.();
			const scheme = adminTls ? "https" : "http";
			const pscheme = config.http.tls ? "https" : "http";
			log.info(`[app] ps-platform ${VERSION} 已启动：管理口 ${scheme}://${config.http.host}:${this.ports.admin}/admin/  观众口 ${this.ports.public ? `${pscheme}://${config.http.publicHost}:${this.ports.public}` : "未启用"}  UE 地址 ${proto}://${ueHost}`);
			packages.prepare().catch(() => {}); // Windows 打包运行时在后台生成 Agent 安装程序
			return this;
		},
		async stop() {
			stopping = true;
			for (const t of timers) clearInterval(t), clearTimeout(t);
			loopDelay.disable();
			scheduler.stop();
			metrics.stop();
			rateLimiter.stop();
			signaling.close();
			// 平台正常停止时一并结束本机 Agent 拉起的 UE（异常崩溃时则由进程表在下次启动时接管）
			for (const a of agents.agents.values()) {
				if (!a.local) continue;
				if (config.localAgent.killOnStop !== false) a.agent?.killAll();
				a.close();
			}
			turnProc?.kill();
			for (const ws of EVENTS.clients) ws.terminate();
			await Promise.all(servers.map((s) => new Promise((r) => (s.closeAllConnections?.(), s.close(() => r())))));
			store.close();
			log.close?.();
		},
	};
}

module.exports = { createApp, VERSION };
