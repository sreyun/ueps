"use strict";
/**
 * 运行期设置（管理端可在线修改，立即生效）与密钥管理。
 *   - 密钥（JWT、Agent 令牌、内置 TURN 共享密钥）首次启动随机生成并保存在数据库，可用环境变量覆盖。
 *   - TURN 服务器条目的 secret 写成 "@builtin" 表示使用内置 TURN 的密钥（界面上不暴露真实密钥）。
 */
const { randomSecret } = require("./util.js");

const BUILTIN = "@builtin";
const MASK = "******";

/**
 * 管理端提交的列表里密钥显示为 "******"，表示"保持原值"。
 * 按 id 匹配原条目；没有 id 时按相同位置且 urls 相同匹配（避免列表重排后错配密钥）。
 */
function unmask(list, oldList = []) {
	oldList = Array.isArray(oldList) ? oldList : [];
	const sameUrls = (a, b) => JSON.stringify([].concat(a?.urls || [])) === JSON.stringify([].concat(b?.urls || []));
	return list.map((s, i) => {
		if (!s || typeof s !== "object") return s;
		const old = s.id ? oldList.find((o) => o.id === s.id) : sameUrls(oldList[i], s) ? oldList[i] : oldList.find((o) => !o.id && sameUrls(o, s));
		const out = { ...s };
		if (s.secret === MASK) out.secret = old?.secret;
		if (s.credential === MASK) out.credential = old?.credential;
		return out;
	});
}

function loadSecrets(store, env = process.env) {
	const s = store.getSetting("secrets", {});
	let changed = false;
	for (const k of ["jwt", "agentToken", "turn"]) {
		if (!s[k]) {
			s[k] = randomSecret(k === "agentToken" ? 24 : 32);
			changed = true;
		}
	}
	if (changed) store.setSetting("secrets", s);
	return {
		jwt: env.PS_JWT_SECRET || s.jwt,
		agentToken: env.PS_AGENT_TOKEN || s.agentToken,
		turn: env.TURN_SECRET || s.turn,
		rotateAgentToken() {
			const cur = store.getSetting("secrets", {});
			cur.agentToken = randomSecret(24);
			store.setSetting("secrets", cur);
			this.agentToken = env.PS_AGENT_TOKEN || cur.agentToken;
			return this.agentToken;
		},
	};
}

function defaultRuntime(config) {
	const servers = [];
	if (config.turn.builtin.enable) {
		servers.push({
			id: "nginx",
			name: "nginx 同端口 TURN（内置）",
			urls: ["turn:{host}:{port}?transport=tcp", "turns:{host}:{port}?transport=tcp"],
			secret: BUILTIN,
			scope: "player",
			audience: "all",
			enable: true,
		});
	}
	for (const s of config.turn.servers || []) servers.push(structuredClone(s)); // config.json / DC_TURN_URLS 指定的数据中心 STUN/TURN
	return {
		turn: { forceRelay: config.turn.forceRelay ?? false, ttl: 86400, ueTtl: 2592000, servers },
		iceServers: [],
		ueIceServers: null,
		maxPlayersPerIp: 0,
		security: {
			viewerAllow: [], // 观众 IP/网段白名单（空 = 不限），对所有程序生效
			corsOrigins: [], // 允许跨域调用 API 的来源（配合 API 令牌做二次开发），例如 https://app.example.com
			publicTools: false, // 工具接口（寻路/坐标转换）是否免登录开放（观众口也可调用）
			rateLimit: { wsPerSec: 20, wsBurst: 100, apiPerSec: 20, apiBurst: 60 }, // 每 IP 限流，0 = 不限（企业 NAT 下几十人共用一个出口 IP，观众连接不宜过严）
		},
		alerts: { webhook: "", format: "generic", name: "云渲染管理平台", events: ["agent.offline", "instance.failed", "program.capacity", "queue.backlog", "turn.down"], queueBacklogSec: 60, throttleSec: 60 },
	};
}

function validateRuntime(r) {
	const errs = [];
	const t = r.turn || {};
	if (![false, true, "external"].includes(t.forceRelay)) errs.push("turn.forceRelay 取值：false / true / \"external\"");
	for (const k of ["ttl", "ueTtl"]) if (t[k] !== undefined && !(Number.isInteger(t[k]) && t[k] >= 60)) errs.push(`turn.${k} 必须是 ≥60 的整数（秒）`);
	if (!Array.isArray(t.servers)) errs.push("turn.servers 必须是数组");
	for (const [i, s] of (t.servers || []).entries()) {
		const urls = [].concat(s.urls || []);
		if (!urls.length || urls.some((u) => typeof u !== "string" || !/^(stun|turns?):/i.test(u))) errs.push(`turn.servers[${i}].urls 必须是 stun:/turn:/turns: 地址`);
		if (s.scope && !["player", "ue", "all"].includes(s.scope)) errs.push(`turn.servers[${i}].scope 取值：player / ue / all`);
		if (s.audience && !["all", "external", "lan"].includes(s.audience)) errs.push(`turn.servers[${i}].audience 取值：all / external / lan`);
		if (urls.some((u) => /\{host\}/.test(u)) && (s.scope || "player") !== "player") errs.push(`turn.servers[${i}]：含 {host} 的地址只能用于观众（scope=player）`);
	}
	const iceOk = (list) => Array.isArray(list) && list.every((x) => x && typeof x === "object" && [].concat(x.urls || []).length && [].concat(x.urls).every((u) => typeof u === "string" && /^(stun|turns?):/i.test(u)));
	if (!iceOk(r.iceServers)) errs.push("iceServers 必须是 [{ urls, username?, credential? }] 数组，地址以 stun:/turn:/turns: 开头");
	if (r.ueIceServers !== null && r.ueIceServers !== undefined && !iceOk(r.ueIceServers)) errs.push("ueIceServers 必须是 null 或 ICE 服务器数组");
	if (!(Number.isInteger(r.maxPlayersPerIp) && r.maxPlayersPerIp >= 0)) errs.push("maxPlayersPerIp 必须是非负整数");
	const sec = r.security || {};
	if (!Array.isArray(sec.viewerAllow) || sec.viewerAllow.some((x) => !/^[0-9a-fA-F.:/]+$/.test(String(x)))) errs.push("security.viewerAllow 必须是 IP/CIDR 数组");
	if (!Array.isArray(sec.corsOrigins) || sec.corsOrigins.some((o) => o !== "*" && !/^https?:\/\/[^/\s]+$/.test(String(o)))) errs.push("security.corsOrigins 必须是形如 https://app.example.com 的来源（不带路径）");
	for (const k of ["wsPerSec", "wsBurst", "apiPerSec", "apiBurst"]) if (!(Number(sec.rateLimit?.[k]) >= 0)) errs.push(`security.rateLimit.${k} 必须是非负数`);
	const al = r.alerts || {};
	if (al.webhook && !/^https?:\/\//.test(al.webhook)) errs.push("alerts.webhook 必须是 http/https 地址");
	if (!["generic", "wecom", "dingtalk", "feishu"].includes(al.format || "generic")) errs.push("alerts.format 取值：generic / wecom / dingtalk / feishu");
	if (!Array.isArray(al.events)) errs.push("alerts.events 必须是数组");
	if (errs.length) throw Object.assign(new Error(errs.join("；")), { status: 400 });
	return r;
}

class Settings {
	constructor(store, secrets, config) {
		this.store = store;
		this.secrets = secrets;
		this.config = config;
		const def = defaultRuntime(config);
		const saved = store.getSetting("runtime") || {};
		// 深合并一层：新版本增加的设置项自动获得默认值
		this.raw = { ...def, ...saved, security: { ...def.security, ...(saved.security || {}), rateLimit: { ...def.security.rateLimit, ...(saved.security?.rateLimit || {}) } }, alerts: { ...def.alerts, ...(saved.alerts || {}) } };
		this.cache = null;
	}
	/** 给信令用：@builtin 解析成真实密钥 */
	get() {
		if (this.cache) return this.cache;
		const r = structuredClone(this.raw);
		for (const s of r.turn?.servers || []) if (s.secret === BUILTIN) s.secret = this.secrets.turn;
		this.cache = r;
		return r;
	}
	/** 给管理端看：隐藏第三方 TURN 密钥 */
	view() {
		const r = structuredClone(this.raw);
		for (const s of [...(r.turn?.servers || []), ...(r.iceServers || []), ...(r.ueIceServers || [])]) {
			if (s.secret && s.secret !== BUILTIN) s.secret = MASK;
			if (s.credential) s.credential = MASK;
		}
		return r;
	}
	update(patch) {
		const next = structuredClone(this.raw);
		if (patch.turn) {
			const servers = patch.turn.servers;
			Object.assign(next.turn, patch.turn);
			if (Array.isArray(servers)) next.turn.servers = unmask(servers, this.raw.turn.servers);
		}
		for (const k of ["iceServers", "ueIceServers"]) if (patch[k] !== undefined) next[k] = Array.isArray(patch[k]) ? unmask(patch[k], this.raw[k]) : patch[k];
		if (patch.maxPlayersPerIp !== undefined) next.maxPlayersPerIp = patch.maxPlayersPerIp;
		if (patch.security) next.security = { ...next.security, ...patch.security, rateLimit: { ...next.security.rateLimit, ...(patch.security.rateLimit || {}) } };
		if (patch.alerts) next.alerts = { ...next.alerts, ...patch.alerts };
		validateRuntime(next);
		this.store.setSetting("runtime", next); // 先持久化，成功后再替换内存中的设置
		this.raw = next;
		this.cache = null;
		return this.view();
	}
}

module.exports = { Settings, loadSecrets, BUILTIN, validateRuntime };
