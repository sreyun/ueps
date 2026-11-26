"use strict";
/**
 * 配置中心：把原来只能写在 config.json / 环境变量里的启动参数迁移到管理端统一维护。
 *
 * 三层配置
 *   1. 启动参数（BOOTSTRAP）：打开数据库、监听端口之前就要用到的项（数据目录、端口、TLS 证书、网页目录、首次口令、固定密钥），
 *      只能写在 config.json 或环境变量中，管理端只读展示其值与来源。
 *   2. 托管参数（MANAGED，本文件的注册表）：在管理端「系统设置 → 系统参数」中修改，保存在数据库 settings 表；
 *      每项声明类型、校验、默认值、对应的环境变量，以及生效方式（live 立即生效 / restart 重启平台后生效）。
 *   3. 运行期设置（settings.js：对外地址、TURN/ICE、安全、告警）：本来就在管理端维护，不变。
 *
 * 托管参数的优先级：环境变量（锁定，管理端只读） > 管理端保存的值 > 内置默认值
 *   - 设置了环境变量的项保持原有行为（兼容已有部署），同时把环境变量的值保存下来：以后删除该环境变量，仍沿用这个值。
 *   - config.json 中的托管参数只在升级后首次启动时导入一次（迁移），之后以管理端为准；文件中的值与生效值不一致时给出提示。
 *   - 数据库中的值不合法（手工修改、版本回退）时忽略并使用默认值，同时记录警告。
 *
 * 持久化：settings 表 config.values（{ 键: 值 }）与 config.meta（{ schema, rev, imported, adopted, updated }）。
 * 缓存：生效值直接写回 config 对象（各模块按原样读取 config.xxx，无需改动），读取不访问数据库；写入先落库、成功后再替换内存。
 * 并发：每次保存 rev + 1，提交时携带 rev，不一致返回 409（另一位管理员已修改）。
 */
const { EventEmitter } = require("events");
const { DEFAULTS } = require("./config.js");

const SCHEMA = 1;

/* ------------------------------------------------------------------ 类型与校验 */

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const toList = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,，;；]+/)).map((s) => String(s).trim()).filter(Boolean);
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const isIpv4 = (s) => IPV4.test(s);
const isIpv6 = (s) => /^[0-9a-f:.]+$/i.test(s) && s.includes(":") && s.split(":").length <= 9 && !/:::/.test(s);
const isIp = (s) => isIpv4(s) || isIpv6(s);
const isCidr = (s) => {
	const [ip, bits, extra] = s.split("/");
	if (extra !== undefined) return false;
	if (bits === undefined) return isIp(ip);
	return isIpv4(ip) && /^\d{1,2}$/.test(bits) && +bits <= 32;
};
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])$/i;
const hostPort = (s, needPort) => {
	const m = String(s).match(/^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
	if (!m || !HOST.test(m[1])) return false;
	if (needPort && !m[2]) return false;
	return !m[2] || (+m[2] >= 1 && +m[2] <= 65535);
};
const absPath = (s) => /^[a-z]:[\\/]/i.test(s) || s.startsWith("/") || s.startsWith("\\\\");

/** 每种类型：normalize(输入) → 规范值；不合法时抛出带原因的错误。label 用于错误信息 */
const TYPES = {
	bool: (v) => {
		if (typeof v === "boolean") return v;
		if (/^(1|true|yes|on)$/i.test(String(v))) return true;
		if (/^(0|false|no|off|)$/i.test(String(v))) return false;
		throw bad("取值应为 是 / 否");
	},
	int: (v, d) => {
		const n = Number(v);
		if (!Number.isInteger(n) || n < d.min || n > d.max) throw bad(`应为 ${d.min}–${d.max} 的整数`);
		return n;
	},
	enum: (v, d) => {
		if (!d.options.some((o) => o.value === v)) throw bad(`取值：${d.options.map((o) => o.value).join(" / ")}`);
		return v;
	},
	cidrs: (v, d) => {
		const list = toList(v);
		const wrong = list.filter((s) => !isCidr(s));
		if (wrong.length) throw bad(`不是合法的 IP 或 IPv4 网段：${wrong.join("、")}（IPv6 只支持填写具体地址）`);
		if (d.required && !list.length) throw bad("至少填写一个 IP 或网段（不限制可填 0.0.0.0/0）");
		return [...new Set(list)];
	},
	ips: (v) => {
		const list = toList(v);
		const wrong = list.filter((s) => !isIp(s));
		if (wrong.length) throw bad(`不是合法的 IP 地址：${wrong.join("、")}`);
		return [...new Set(list)];
	},
	paths: (v) => {
		const list = toList(Array.isArray(v) ? v : String(v ?? "").split(/[\n;；]+/));
		const wrong = list.filter((s) => !absPath(s));
		if (wrong.length) throw bad(`必须是完整路径（例如 D:\\UE 或 /opt/ue）：${wrong.join("、")}`);
		return [...new Set(list.map((s) => (/^[a-z]:[\\/]$/i.test(s) || s === "/" ? s : s.replace(/[\\/]+$/, ""))))];
	},
	url: (v) => {
		const s = String(v ?? "").trim();
		if (s && !/^https?:\/\/[^\s]+$/i.test(s)) throw bad("必须以 http:// 或 https:// 开头（留空 = 不提供一键获取）");
		return s.replace(/\/+$/, "");
	},
	hostOrAuto: (v) => {
		const s = String(v ?? "").trim().toLowerCase() || "auto";
		if (s !== "auto" && !hostPort(s, false)) throw bad("应为 auto，或 IP / 域名[:端口]，例如 192.168.1.10:88");
		return s;
	},
	listen: (v) => {
		const list = toList(v);
		const wrong = list.filter((s) => !hostPort(s, true));
		if (wrong.length) throw bad(`应为 IP:端口，例如 127.0.0.1:3478：${wrong.join("、")}`);
		if (!list.length) throw bad("至少填写一个监听地址，例如 127.0.0.1:3478");
		return list;
	},
	ipOrAuto: (v) => {
		const s = String(v ?? "").trim() || "auto";
		if (s !== "auto" && !isIpv4(s)) throw bad("应为 auto 或 IPv4 地址（UE 能访问到的内网地址）");
		return s;
	},
	workers: (v) => {
		const s = String(v ?? "").trim() || "auto";
		if (s === "auto") return s;
		const n = Number(s);
		if (!Number.isInteger(n) || n < 1 || n > 64) throw bad("应为 auto 或 1–64 的整数");
		return n;
	},
	optHostPort: (v) => {
		const s = String(v ?? "").trim();
		if (!s) return null;
		if (!hostPort(s, true)) throw bad("应为 IP:端口，例如 127.0.0.1:8090；留空 = 不启用");
		return s;
	},
};

/* ------------------------------------------------------------------ 注册表 */

const GROUPS = [
	{ id: "network", title: "网络与访问控制", desc: "谁可以访问管理端、哪些 UE / 渲染机可以接入，以及如何识别观众的真实地址" },
	{ id: "agent", title: "内置本机 Agent", desc: "平台所在机器同时作为渲染机时使用（单机部署）" },
	{ id: "log", title: "日志与数据保留", desc: "运行日志与观众会话历史" },
	{ id: "downloads", title: "Agent 安装包", desc: "「接入渲染机」中一键获取安装包的来源" },
	{ id: "turn", title: "内置 TURN 中继", desc: "外网观众经 nginx 同端口中继；须与 nginx 配置、防火墙端口一致，一般保持部署时的设置" },
];

const MANAGED = [
	{ key: "security.adminAllow", group: "network", label: "管理端允许网段", type: "cidrs", required: true, env: "PS_ADMIN_ALLOW", apply: "live", help: "可以打开管理端、调用 API 的来源 IP / 网段。保存前会检查你当前的地址仍在其中，避免把自己锁在外面" },
	{ key: "security.engineAllow", group: "network", label: "UE / Agent 允许网段", type: "cidrs", required: true, env: "PS_ENGINE_ALLOW", apply: "live", help: "允许连接平台的 UE 与渲染机 Agent 的来源 IP / 网段；本机回环地址始终允许" },
	{ key: "security.trustProxy", group: "network", label: "可信反向代理", type: "ips", env: "PS_TRUST_PROXY", apply: "live", help: "前面还有一层反向代理（路由器反代、负载均衡、1Panel 等）时填写它的 IP，平台才会采用 X-Forwarded-For 中的真实地址。本机回环地址始终可信" },
	{ key: "security.lanNetworks", group: "network", label: "额外内网网段", type: "cidrs", env: "PS_LAN_NETWORKS", apply: "live", help: "10/8、172.16/12、192.168/16 之外仍视为内网观众的网段（例如 100.64.0.0/10），影响「仅外网观众」的中继策略与统计" },
	{ key: "gateway.ueHost", group: "network", label: "UE 连接地址", type: "hostOrAuto", env: "PS_UE_HOST", apply: "restart", hint: "auto = 自动", help: "UE 连接平台使用的地址。auto：本机 Agent 使用第一个内网 IP + 管理端口，渲染机使用其连接平台的地址；也可填写 192.168.1.10:88" },
	{ key: "security.sessionTtlHours", group: "network", label: "登录有效期（小时）", type: "int", min: 1, max: 720, apply: "live", help: "管理端登录的有效期，对之后的登录生效" },
	{ key: "localAgent.enable", group: "agent", label: "启用本机 Agent", type: "bool", env: "PS_LOCAL_AGENT", apply: "restart", help: "平台所在机器同时作为渲染机（单机部署）。Docker 部署默认关闭" },
	{ key: "localAgent.allowExe", group: "agent", label: "允许启动的程序目录", type: "paths", env: "PS_LOCAL_AGENT_ALLOW_EXE", apply: "restart", hint: "留空 = 不限制", help: "每行一个完整路径；本机 Agent 只允许启动这些目录下的程序（强烈建议填写）" },
	{ key: "localAgent.killOnStop", group: "agent", label: "平台停止时结束 UE", type: "bool", apply: "live", help: "关闭后平台重启期间 UE 保持运行，平台启动后自动接管" },
	{ key: "log.level", group: "log", label: "日志级别", type: "enum", options: [{ value: "debug", label: "调试（debug）" }, { value: "info", label: "信息（info）" }, { value: "warn", label: "警告（warn）" }, { value: "error", label: "错误（error）" }], env: "PS_LOG_LEVEL", apply: "live", help: "排查问题时临时改为调试，平时用信息" },
	{ key: "log.file", group: "log", label: "写入日志文件", type: "bool", apply: "restart", help: "按天保存在数据目录 logs/ 下" },
	{ key: "log.retentionDays", group: "log", label: "日志保留天数", type: "int", min: 1, max: 3650, apply: "live" },
	{ key: "history.retentionDays", group: "log", label: "会话历史保留天数", type: "int", min: 1, max: 3650, apply: "live", help: "观众会话记录超过天数后每 6 小时清理一次" },
	{ key: "downloads.releaseBaseUrl", group: "downloads", label: "发布页地址", type: "url", env: "PS_RELEASE_BASE_URL", envAllowEmpty: true, apply: "live", hint: "留空 = 不提供一键获取", help: "「接入渲染机」一键获取安装包的来源。{version} 替换为平台版本；内网可改为自建镜像（目录中放同名文件）" },
	{ key: "turn.builtin.enable", group: "turn", label: "启用内置 TURN", type: "bool", env: "TURN_BUILTIN", apply: "restart" },
	{ key: "turn.builtin.listen", group: "turn", label: "监听地址", type: "listen", env: "TURN_LISTEN", apply: "restart", help: "nginx 把 TURN 流量转发到这里，须与 nginx 配置一致" },
	{ key: "turn.builtin.relayIp", group: "turn", label: "中继地址", type: "ipOrAuto", env: "TURN_RELAY_IP", apply: "restart", hint: "auto = 第一个内网 IP", help: "UE 能访问到的本机内网 IPv4，不要填公网 IP" },
	{ key: "turn.builtin.minPort", group: "turn", label: "中继端口起", type: "int", min: 1024, max: 65535, env: "TURN_MIN_PORT", apply: "restart" },
	{ key: "turn.builtin.maxPort", group: "turn", label: "中继端口止", type: "int", min: 1024, max: 65535, env: "TURN_MAX_PORT", apply: "restart" },
	{ key: "turn.builtin.workers", group: "turn", label: "工作进程数", type: "workers", env: "TURN_WORKERS", apply: "restart", hint: "auto = 按 CPU 核数" },
	{ key: "turn.builtin.allowedPeers", group: "turn", label: "允许中继的网段", type: "cidrs", env: "TURN_ALLOWED_PEERS", apply: "restart", help: "只允许中继到这些地址（UE 所在网段），防止被当作开放代理" },
	{ key: "turn.builtin.httpFallback", group: "turn", label: "同端口 http 转发", type: "optHostPort", env: "TURN_HTTP_FALLBACK", envAllowEmpty: true, apply: "restart", hint: "留空 = 不启用", help: "同一端口兼容 http:// 访问时使用（nginx 的 proxy_protocol http 服务）" },
];
const BY_KEY = new Map(MANAGED.map((d) => [d.key, d]));

/** 启动参数（只读展示）：键 → 说明与环境变量 */
const BOOTSTRAP = [
	{ key: "dataDir", label: "数据目录", env: "PS_DATA_DIR" },
	{ key: "configFile", label: "配置文件", env: "PS_CONFIG" },
	{ key: "http.host", label: "管理口监听地址", env: "PS_HOST" },
	{ key: "http.port", label: "管理口端口", env: "PS_PORT" },
	{ key: "http.publicHost", label: "观众口监听地址", env: "PS_PUBLIC_HOST" },
	{ key: "http.publicPort", label: "观众口端口", env: "PS_PUBLIC_PORT" },
	{ key: "http.tls", label: "内置 TLS 证书", env: "PS_TLS_CERT" },
	{ key: "site.dir", label: "自定义网页目录", env: "PS_SITE_DIR" },
];
/** 只在首次启动时作为运行期设置初始值的环境变量（之后以管理端为准，行为不变） */
const SEED_ENV = ["PS_PUBLIC_BASE_URL", "TURN_FORCE_RELAY", "DC_TURN_URLS", "UE_TURN_URLS"];
/** 固定密钥 / 首次口令：设置后覆盖数据库中自动生成的值（只显示是否设置） */
const SECRET_ENV = ["PS_JWT_SECRET", "PS_AGENT_TOKEN", "TURN_SECRET", "PS_ADMIN_PASSWORD"];

/* ------------------------------------------------------------------ 工具 */

const getPath = (o, key) => key.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, key, v) {
	const ks = key.split(".");
	let x = o;
	for (const k of ks.slice(0, -1)) x = x[k] ??= {};
	x[ks.at(-1)] = v;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function normalize(def, value) {
	try {
		return TYPES[def.type](value, def);
	} catch (e) {
		throw bad(`${def.label}：${e.message}`);
	}
}

/* ------------------------------------------------------------------ 配置中心 */

class ConfigCenter extends EventEmitter {
	/**
	 * @param {object} o
	 * @param {Store}  o.store
	 * @param {object} o.config  loadConfig() 的结果（会被就地更新为生效值）
	 * @param {object} o.env
	 */
	constructor({ store, config, env = process.env }) {
		super();
		this.store = store;
		this.config = config;
		this.env = env;
		this.notes = []; // 启动过程中的提示（日志创建后输出）
		this.envValues = {}; // 环境变量给出的值（loadConfig 已解析）
		for (const d of MANAGED) if (this.envSet(d)) this.envValues[d.key] = clone(getPath(config, d.key));
		this.fileValues = config.fileValues || {};
		this.load();
	}

	envSet(d) {
		if (!d.env) return false;
		const v = this.env[d.env];
		return d.envAllowEmpty ? v !== undefined : v !== undefined && v !== "";
	}

	/** 从数据库读取、迁移、计算生效值并写入 config（启动时调用一次；恢复备份后也会调用） */
	load() {
		const stored = this.store.getSetting("config.values", {}) || {};
		const meta = { schema: 0, rev: 0, imported: {}, adopted: {}, updated: {}, ...(this.store.getSetting("config.meta", {}) || {}) };
		let dirty = false;
		// 迁移 v1：导入 config.json 中的托管参数（只做一次）
		if (meta.schema < 1) {
			const imported = [];
			for (const d of MANAGED) {
				const fv = getPath(this.fileValues, d.key);
				if (fv === undefined || this.envSet(d) || stored[d.key] !== undefined) continue;
				try {
					stored[d.key] = normalize(d, fv);
					meta.imported[d.key] = "config.json";
					imported.push(d.key);
				} catch (e) {
					this.notes.push(["warn", `[config] config.json 中的 ${d.key} 不合法，未导入：${e.message}`]);
				}
			}
			if (imported.length) this.notes.push(["info", `[config] 已把 config.json 中的 ${imported.length} 项参数导入管理端（${imported.join("、")}），之后请在「系统设置 → 系统参数」中修改`]);
			meta.schema = SCHEMA;
			meta.migratedAt = Date.now();
			dirty = true;
		}
		// 环境变量锁定的项：保存其值，以后删除该环境变量仍沿用
		for (const d of MANAGED) {
			if (!this.envSet(d)) continue;
			let v;
			try {
				v = normalize(d, this.envValues[d.key]);
			} catch (e) {
				throw new Error(`配置错误：环境变量 ${d.env} 不合法：${e.message}`);
			}
			this.envValues[d.key] = v;
			if (!same(stored[d.key], v)) {
				stored[d.key] = v;
				meta.adopted[d.key] = d.env;
				dirty = true;
			}
		}
		// 数据库中的值逐项校验（不合法的忽略）
		for (const [k, v] of Object.entries(stored)) {
			const d = BY_KEY.get(k);
			if (!d) continue; // 未来版本的键：保留但不使用
			try {
				stored[k] = normalize(d, v);
			} catch (e) {
				this.notes.push(["warn", `[config] 已保存的 ${k} 不合法，改用默认值：${e.message}`]);
				delete stored[k];
				dirty = true;
			}
		}
		if (dirty) {
			this.store.transaction(() => {
				this.store.setSetting("config.values", stored);
				this.store.setSetting("config.meta", meta);
			});
		}
		this.stored = stored;
		this.meta = meta;
		const first = !this.boot;
		if (first) this.boot = {};
		for (const d of MANAGED) {
			const v = this.effective(d.key);
			if (first) {
				this.boot[d.key] = clone(v);
				setPath(this.config, d.key, clone(v));
			} else if (d.apply === "live") this.applyLive(d, v);
		}
		this.checkCross(this.valuesForCheck({}));
		return this;
	}

	/** 生效值：环境变量 > 管理端保存 > 默认 */
	effective(key) {
		if (key in this.envValues) return this.envValues[key];
		if (this.stored[key] !== undefined) return this.stored[key];
		return clone(getPath(DEFAULTS, key));
	}

	source(key) {
		if (key in this.envValues) return "env";
		if (this.stored[key] !== undefined) return "admin";
		return "default";
	}

	/** 重启后才生效的项：保存值与本次启动时的值不同 */
	pending(key) {
		const d = BY_KEY.get(key);
		return d.apply === "restart" && !same(this.effective(key), this.boot[key]);
	}

	pendingCount() {
		return MANAGED.filter((d) => this.pending(d.key)).length;
	}

	/** 有待重启项的分组（管理端提示中的链接直接打开该分组） */
	pendingGroups() {
		return [...new Set(MANAGED.filter((d) => this.pending(d.key)).map((d) => d.group))];
	}

	applyLive(d, v) {
		const old = getPath(this.config, d.key);
		if (same(old, v)) return;
		setPath(this.config, d.key, clone(v));
		this.emit("change", { key: d.key, value: v, old });
	}

	valuesForCheck(patch) {
		const o = {};
		for (const d of MANAGED) o[d.key] = d.key in patch ? patch[d.key] : this.effective(d.key);
		return o;
	}

	/** 跨字段校验 */
	checkCross(v) {
		if (v["turn.builtin.enable"] && v["turn.builtin.minPort"] > v["turn.builtin.maxPort"]) throw bad("内置 TURN：中继端口起不能大于中继端口止");
	}

	/**
	 * 保存（管理端）。values = { 键: 新值 }；rev 必须等于当前版本。
	 * guard(next) 可抛出错误阻止保存（例如保存后当前管理员将无法访问管理端）。
	 * @returns {{ changes: Array<{key, from, to, apply}> }}
	 */
	update(values, { rev, by = "", guard } = {}) {
		if (rev !== undefined && rev !== null && Number(rev) !== this.meta.rev) throw Object.assign(new Error("设置已被其他管理员修改，请刷新后重试"), { status: 409 });
		if (!values || typeof values !== "object" || Array.isArray(values)) throw bad("请求格式：{ rev, values: { 键: 值 } }");
		const patch = {};
		for (const [k, raw] of Object.entries(values)) {
			const d = BY_KEY.get(k);
			if (!d) throw bad(`未知的参数：${k}`);
			if (k in this.envValues) throw Object.assign(new Error(`${d.label} 由环境变量 ${d.env} 锁定，请修改或删除该环境变量后重启平台`), { status: 409 });
			patch[k] = normalize(d, raw);
		}
		const next = this.valuesForCheck(patch);
		this.checkCross(next);
		if (guard) guard(next);
		const changes = Object.entries(patch)
			.filter(([k, v]) => !same(this.effective(k), v))
			.map(([k, v]) => ({ key: k, from: this.effective(k), to: v, apply: BY_KEY.get(k).apply }));
		if (!changes.length) return { changes };
		this.commit((stored, meta) => {
			for (const c of changes) {
				stored[c.key] = c.to;
				meta.updated[c.key] = { at: Date.now(), by };
				delete meta.imported[c.key];
			}
		});
		for (const c of changes) if (c.apply === "live") this.applyLive(BY_KEY.get(c.key), c.to);
		this.emit("saved", { changes, rev: this.meta.rev });
		return { changes };
	}

	/** 恢复默认（删除管理端保存的值） */
	reset(keys, { rev, by = "", guard } = {}) {
		if (rev !== undefined && rev !== null && Number(rev) !== this.meta.rev) throw Object.assign(new Error("设置已被其他管理员修改，请刷新后重试"), { status: 409 });
		if (!Array.isArray(keys) || !keys.length) throw bad("请指定要恢复默认的参数");
		for (const k of keys) {
			const d = BY_KEY.get(k);
			if (!d) throw bad(`未知的参数：${k}`);
			if (k in this.envValues) throw Object.assign(new Error(`${d.label} 由环境变量 ${d.env} 锁定，不能恢复默认`), { status: 409 });
		}
		const patch = Object.fromEntries(keys.map((k) => [k, clone(getPath(DEFAULTS, k))]));
		const next = this.valuesForCheck(patch);
		this.checkCross(next);
		if (guard) guard(next);
		const changes = keys.filter((k) => this.stored[k] !== undefined).map((k) => ({ key: k, from: this.effective(k), to: patch[k], apply: BY_KEY.get(k).apply }));
		if (!changes.length) return { changes };
		this.commit((stored, meta) => {
			for (const c of changes) {
				delete stored[c.key];
				meta.updated[c.key] = { at: Date.now(), by, reset: true };
			}
		});
		for (const c of changes) if (c.apply === "live") this.applyLive(BY_KEY.get(c.key), c.to);
		this.emit("saved", { changes, rev: this.meta.rev });
		return { changes };
	}

	/** 先落库，成功后再替换内存（写入失败时内存保持原值） */
	commit(fn) {
		const stored = clone(this.stored);
		const meta = clone(this.meta);
		fn(stored, meta);
		meta.rev = (meta.rev || 0) + 1;
		this.store.transaction(() => {
			this.store.setSetting("config.values", stored);
			this.store.setSetting("config.meta", meta);
		});
		this.stored = stored;
		this.meta = meta;
	}

	/** 备份：管理端保存的值（不含环境变量锁定的项） */
	exportValues() {
		return Object.fromEntries(Object.entries(this.stored).filter(([k]) => BY_KEY.has(k) && !(k in this.envValues)));
	}

	/** 恢复备份：校验全部通过才写入；锁定的项跳过 */
	importValues(values, { by = "", guard } = {}) {
		const usable = Object.fromEntries(Object.entries(values || {}).filter(([k]) => BY_KEY.has(k) && !(k in this.envValues)));
		const skipped = Object.keys(values || {}).filter((k) => !(k in usable));
		const r = this.update(usable, { by, guard });
		return { ...r, skipped };
	}

	/** config.json 中仍写着、但已不再生效（与当前值不同）的托管参数 */
	staleFileKeys() {
		return MANAGED.filter((d) => {
			const fv = getPath(this.fileValues, d.key);
			if (fv === undefined || d.key in this.envValues) return false;
			try {
				return !same(normalize(d, fv), this.effective(d.key));
			} catch {
				return true;
			}
		}).map((d) => d.key);
	}

	/** 启动参数的来源 */
	bootstrapSource(b) {
		if (b.key === "http.tls") return this.env.PS_TLS_CERT && this.env.PS_TLS_KEY ? "env" : this.fileValues.http?.tls ? "config.json" : "default";
		if (b.env && this.env[b.env]) return "env";
		if (b.key === "configFile") return "default";
		if (b.key === "site.dir") return this.fileValues.site?.dir ? "config.json" : "default";
		return getPath(this.fileValues, b.key) !== undefined ? "config.json" : "default";
	}

	/** 管理端展示用 */
	view() {
		const items = MANAGED.map((d) => ({
			key: d.key,
			group: d.group,
			label: d.label,
			hint: d.hint || "",
			help: d.help || "",
			type: d.type,
			options: d.options,
			min: d.min,
			max: d.max,
			required: !!d.required,
			apply: d.apply,
			value: this.effective(d.key),
			default: clone(getPath(DEFAULTS, d.key)),
			stored: this.stored[d.key] === undefined ? null : this.stored[d.key],
			source: this.source(d.key),
			env: d.env || null,
			locked: d.key in this.envValues,
			pending: this.pending(d.key),
			bootValue: this.boot[d.key],
			imported: this.meta.imported[d.key] || null,
			updated: this.meta.updated[d.key] || null,
		}));
		const bootstrap = BOOTSTRAP.map((b) => {
			let value = getPath(this.config, b.key);
			if (b.key === "http.tls") value = value ? `${value.cert}（${value.admin ? "观众口与管理口" : "观众口"}）` : "未启用（由 nginx 提供 https）";
			return { key: b.key, label: b.label, value, source: this.bootstrapSource(b), env: b.env };
		});
		const warnings = this.staleFileKeys().map((k) => `config.json 中的 ${k} 已不再生效（当前以管理端为准）：可在下方修改，或从 config.json 中删除该项以免误解`);
		return {
			rev: this.meta.rev,
			groups: GROUPS,
			items,
			bootstrap,
			envSeeds: SEED_ENV.filter((k) => this.env[k]),
			envSecrets: SECRET_ENV.filter((k) => this.env[k]),
			pendingRestart: this.pendingCount(),
			warnings,
		};
	}

	/** 命令行 --show-config：每项的生效值与来源 */
	describe() {
		const src = { env: "环境变量", admin: "管理端", default: "默认", "config.json": "config.json" };
		const fmtv = (v) => (Array.isArray(v) ? v.join(",") || "（空）" : v === null || v === "" ? "（空）" : String(v));
		const lines = ["启动参数（config.json / 环境变量，修改后重启生效）："];
		for (const b of this.view().bootstrap) lines.push(`  ${b.key.padEnd(28)} ${fmtv(b.value).padEnd(40)} ${src[b.source]}${b.source === "env" ? ` ${b.env}` : ""}`);
		lines.push("", "系统参数（管理端「系统设置 → 系统参数」维护）：");
		for (const i of this.view().items) lines.push(`  ${i.key.padEnd(28)} ${fmtv(i.value).padEnd(40)} ${src[i.source]}${i.locked ? ` ${i.env}（锁定）` : ""}${i.pending ? " · 重启后生效" : ""}`);
		return lines.join("\n");
	}
}

module.exports = { ConfigCenter, MANAGED, BOOTSTRAP, GROUPS, SEED_ENV, SECRET_ENV, TYPES, getPath, setPath };
