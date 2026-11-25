"use strict";
/**
 * 启动配置：config.json（与可执行文件/程序目录同级，或 PS_CONFIG 指定）+ 环境变量覆盖。
 * 运行期可在管理端修改的设置（TURN/ICE 服务器、强制中继等）存放在数据库 settings 表，见 store.js。
 */
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
	dataDir: "./data",
	http: {
		port: 88, // 管理端 / API / UE / Agent（仅内网）
		host: "0.0.0.0",
		publicPort: 8088, // 观众专用口（nginx 反代到这里）
		publicHost: "127.0.0.1",
		tls: null, // { cert, key, admin:false }：不经 nginx 直接提供 https/wss。默认只作用于观众口；admin:true 时管理口也启用（UE 需用 wss:// 连接）
	},
	site: {
		dir: "", // 自定义网页托管目录（默认 <dataDir>/www）：放入 html/js 即可在观众口访问，index.html 会替代默认门户页
	},
	gateway: {
		// UE 连接平台使用的地址；auto = Agent 连接平台时使用的地址，内置本机 Agent 用第一个私网 IP
		ueHost: "auto",
	},
	security: {
		trustProxy: ["127.0.0.1", "::1"],
		adminAllow: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
		engineAllow: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
		lanNetworks: [],
		sessionTtlHours: 8,
		maxPlayersPerIp: 0,
	},
	localAgent: {
		enable: true, // 平台进程内置一个"本机"Agent，单机部署无需额外进程
		allowExe: [], // 允许启动的可执行文件所在目录（按目录边界匹配），空 = 不限制
		killOnStop: true, // 平台正常停止时结束本机 Agent 拉起的 UE（异常崩溃后重启会自动接管仍在运行的 UE）
	},
	turn: {
		// 首次启动时写入"系统设置 → TURN"的初始值（之后以管理端保存的设置为准）
		forceRelay: false, // false / true / "external"（只对外网观众强制中继）
		servers: [], // 额外的 STUN/TURN，例如自建数据中心 coturn：[{ id, name, urls:[...], secret, scope, audience }]
		builtin: {
			enable: false,
			workers: "auto",
			listen: ["127.0.0.1:3478"],
			relayIp: "auto",
			minPort: 49160,
			maxPort: 50159,
			allowedPeers: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
			// 同端口明文 http（http://IP:端口/video.html?urlPrefix=xx 这类旧地址、嵌入 http 系统）：
			// nginx 把非 TLS 流量交给 TURN，TURN 识别出 HTTP 后转给这里（nginx 的 proxy_protocol http server）。null = 不启用
			httpFallback: null,
		},
	},
	history: { retentionDays: 90 },
	log: { level: "info", retentionDays: 14, file: true },
};

function merge(base, over) {
	if (!over || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : over;
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) {
		out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) && v && typeof v === "object" && !Array.isArray(v) ? merge(base[k], v) : v;
	}
	return out;
}

function applyEnv(c, env) {
	const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
	const bool = (v) => /^(1|true|yes|on)$/i.test(v);
	if (env.PS_DATA_DIR) c.dataDir = env.PS_DATA_DIR;
	if (env.PS_PORT) c.http.port = +env.PS_PORT;
	if (env.PS_HOST) c.http.host = env.PS_HOST;
	if (env.PS_PUBLIC_PORT) c.http.publicPort = +env.PS_PUBLIC_PORT;
	if (env.PS_PUBLIC_HOST) c.http.publicHost = env.PS_PUBLIC_HOST;
	if (env.PS_UE_HOST) c.gateway.ueHost = env.PS_UE_HOST;
	if (env.PS_ADMIN_ALLOW) c.security.adminAllow = list(env.PS_ADMIN_ALLOW);
	if (env.PS_ENGINE_ALLOW) c.security.engineAllow = list(env.PS_ENGINE_ALLOW);
	if (env.PS_TRUST_PROXY) c.security.trustProxy = list(env.PS_TRUST_PROXY);
	if (env.PS_LAN_NETWORKS) c.security.lanNetworks = list(env.PS_LAN_NETWORKS);
	if (env.PS_LOCAL_AGENT) c.localAgent.enable = bool(env.PS_LOCAL_AGENT);
	if (env.PS_LOCAL_AGENT_ALLOW_EXE) c.localAgent.allowExe = list(env.PS_LOCAL_AGENT_ALLOW_EXE);
	if (env.PS_LOG_LEVEL) c.log.level = env.PS_LOG_LEVEL;
	if (env.PS_TLS_CERT && env.PS_TLS_KEY) c.http.tls = { cert: env.PS_TLS_CERT, key: env.PS_TLS_KEY, admin: bool(env.PS_TLS_ADMIN || "") };
	if (env.PS_SITE_DIR) c.site.dir = env.PS_SITE_DIR;
	if (env.TURN_FORCE_RELAY) c.turn.forceRelay = env.TURN_FORCE_RELAY === "external" ? "external" : bool(env.TURN_FORCE_RELAY);
	if (env.DC_TURN_URLS || env.UE_TURN_URLS) c.turn.servers = [];
	if (env.DC_TURN_URLS) c.turn.servers.push({ id: "dc", name: "数据中心 STUN/TURN", urls: list(env.DC_TURN_URLS), ...(env.DC_TURN_SECRET ? { secret: env.DC_TURN_SECRET } : {}), scope: env.DC_TURN_SCOPE || "all", audience: env.DC_TURN_AUDIENCE || "all", enable: true });
	// 只下发给 UE 的 TURN（UE 无法直连浏览器中继地址时使用，例如演示用无头浏览器 UE）；默认用内置 TURN 的密钥
	if (env.UE_TURN_URLS) c.turn.servers.push({ id: "ue", name: "UE 专用 TURN", urls: list(env.UE_TURN_URLS), secret: env.UE_TURN_SECRET || "@builtin", scope: "ue", audience: "all", enable: true });
	const b = c.turn.builtin;
	if (env.TURN_BUILTIN) b.enable = bool(env.TURN_BUILTIN);
	if (env.TURN_LISTEN) b.listen = list(env.TURN_LISTEN);
	if (env.TURN_RELAY_IP) b.relayIp = env.TURN_RELAY_IP;
	if (env.TURN_MIN_PORT) b.minPort = +env.TURN_MIN_PORT;
	if (env.TURN_MAX_PORT) b.maxPort = +env.TURN_MAX_PORT;
	if (env.TURN_WORKERS) b.workers = env.TURN_WORKERS;
	if (env.TURN_ALLOWED_PEERS) b.allowedPeers = list(env.TURN_ALLOWED_PEERS);
	if (env.TURN_HTTP_FALLBACK !== undefined) b.httpFallback = env.TURN_HTTP_FALLBACK || null;
	return c;
}

function validate(c) {
	const errs = [];
	const port = (v, name) => (Number.isInteger(v) && v >= 0 && v < 65536) || errs.push(`${name} 必须是 0-65535 的整数`);
	port(c.http.port, "http.port");
	port(c.http.publicPort, "http.publicPort");
	if (c.http.port && c.http.port === c.http.publicPort) errs.push("http.port 与 http.publicPort 不能相同");
	for (const k of ["trustProxy", "adminAllow", "engineAllow", "lanNetworks"]) {
		if (!Array.isArray(c.security[k])) errs.push(`security.${k} 必须是数组`);
	}
	if (!(c.security.sessionTtlHours > 0)) errs.push("security.sessionTtlHours 必须大于 0");
	if (!["debug", "info", "warn", "error"].includes(c.log.level)) errs.push("log.level 取值：debug / info / warn / error");
	if (!Array.isArray(c.localAgent.allowExe)) errs.push("localAgent.allowExe 必须是数组");
	if (![false, true, "external"].includes(c.turn.forceRelay)) errs.push('turn.forceRelay 取值：false / true / "external"');
	if (!Array.isArray(c.turn.servers) || c.turn.servers.some((s) => ![].concat(s?.urls || []).length || [].concat(s.urls).some((u) => !/^(stun|turns?):/i.test(String(u))))) errs.push("turn.servers 必须是 [{ urls: [\"stun:/turn:/turns:...\"] }] 数组");
	const b = c.turn.builtin;
	if (b.enable) {
		if (!Array.isArray(b.listen) || !b.listen.length) errs.push("turn.builtin.listen 必须是非空数组，例如 [\"127.0.0.1:3478\"]");
		if (!(Number.isInteger(+b.minPort) && Number.isInteger(+b.maxPort) && +b.minPort > 0 && +b.maxPort < 65536 && +b.minPort <= +b.maxPort)) errs.push("turn.builtin.minPort/maxPort 必须是 1-65535 且 minPort ≤ maxPort");
	}
	if (errs.length) throw new Error("配置错误：\n  " + errs.join("\n  "));
	return c;
}

/** baseDir：配置文件与相对路径（dataDir）的基准目录 */
function loadConfig({ baseDir, file, env = process.env, overrides } = {}) {
	const cfgFile = file || env.PS_CONFIG || path.join(baseDir, "config.json");
	let fromFile = {};
	if (fs.existsSync(cfgFile)) {
		try {
			fromFile = JSON.parse(fs.readFileSync(cfgFile, "utf8").replace(/^﻿/, ""));
		} catch (e) {
			throw new Error(`配置错误：${cfgFile} 不是合法的 JSON（${e.message}）`);
		}
	}
	const c = applyEnv(merge(structuredClone(DEFAULTS), fromFile), env);
	const merged = overrides ? merge(c, overrides) : c;
	merged.dataDir = path.resolve(baseDir, merged.dataDir);
	merged.site.dir = path.resolve(merged.dataDir, merged.site.dir || "www");
	if (merged.http.tls) {
		merged.http.tls = { cert: path.resolve(baseDir, merged.http.tls.cert), key: path.resolve(baseDir, merged.http.tls.key), admin: !!merged.http.tls.admin };
		for (const k of ["cert", "key"]) if (!fs.existsSync(merged.http.tls[k])) throw new Error(`配置错误：http.tls.${k} 文件不存在：${merged.http.tls[k]}`);
	}
	merged.configFile = cfgFile;
	return validate(merged);
}

module.exports = { loadConfig, DEFAULTS, merge };
