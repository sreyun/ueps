"use strict";
/**
 * 持久化：Node.js 内置 node:sqlite（>= 22.13 无需参数；无原生依赖）。WAL 模式，带版本化迁移。
 */
const fs = require("fs");
const path = require("path");

let DatabaseSync;
try {
	// 静默 node:sqlite 的 ExperimentalWarning（Node 22/23）
	const emit = process.emitWarning;
	process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
	({ DatabaseSync } = require("node:sqlite"));
	process.emitWarning = emit;
} catch {
	DatabaseSync = null;
}

const MIGRATIONS = [
	`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'viewer',
		disabled INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		last_login_at INTEGER
	);
	CREATE TABLE programs (
		id TEXT PRIMARY KEY,
		data TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE machines (
		id TEXT PRIMARY KEY,
		name TEXT,
		host TEXT,
		enabled INTEGER NOT NULL DEFAULT 1,
		max_instances INTEGER NOT NULL DEFAULT 0,
		tags TEXT NOT NULL DEFAULT '[]',
		info TEXT NOT NULL DEFAULT '{}',
		last_seen_at INTEGER,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		program_id TEXT,
		instance_id TEXT,
		machine_id TEXT,
		client_ip TEXT,
		external INTEGER,
		user_agent TEXT,
		share_link_id TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		end_reason TEXT,
		avg_kbps REAL,
		avg_rtt_ms REAL,
		avg_fps REAL,
		transport TEXT
	);
	CREATE INDEX sessions_started ON sessions(started_at);
	CREATE INDEX sessions_program ON sessions(program_id, started_at);
	CREATE TABLE share_links (
		id TEXT PRIMARY KEY,
		program_id TEXT NOT NULL,
		note TEXT,
		expires_at INTEGER,
		max_uses INTEGER NOT NULL DEFAULT 0,
		uses INTEGER NOT NULL DEFAULT 0,
		revoked INTEGER NOT NULL DEFAULT 0,
		created_by TEXT,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		username TEXT,
		ip TEXT,
		action TEXT NOT NULL,
		target TEXT,
		detail TEXT
	);
	CREATE INDEX audit_ts ON audit(ts);
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);`,
	`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE users ADD COLUMN totp_secret TEXT;
	ALTER TABLE machines ADD COLUMN gpus_override TEXT NOT NULL DEFAULT '[]';
	CREATE TABLE api_tokens (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		token_hash TEXT NOT NULL,
		role TEXT NOT NULL,
		created_by TEXT,
		created_at INTEGER NOT NULL,
		expires_at INTEGER,
		last_used_at INTEGER,
		revoked INTEGER NOT NULL DEFAULT 0
	);`,
	// VIP 访问链接：排队优先；程序满员时可让出观看时间最长的普通观众的位置（程序 vip_preempt）
	`ALTER TABLE share_links ADD COLUMN vip INTEGER NOT NULL DEFAULT 0;`,
];

const PROGRAM_DEFAULTS = {
	name: "",
	description: "",
	exe: "", // UE 可执行文件（Agent 所在机器上的路径）
	args: "", // 额外启动参数（-PixelStreamingURL/-ResX 等由平台生成）
	cwd: "",
	ue_version: "auto", // auto | 4.27 | 5 | 5.52
	mode: "exclusive", // exclusive：一实例一观众；shared：一实例多观众
	max_viewers: 1, // shared 模式下单实例最大观众数
	prewarm: 0, // 常备空闲实例数（预热，观众进入秒开）
	max_instances: 4, // 该程序最多同时运行的实例数
	idle_release_sec: 120, // 无观众超过该时间释放实例（预热实例除外）
	startup_timeout_sec: 120, // UE 启动后多久内必须连上平台
	res_x: 1920,
	res_y: 1080,
	fps: 30,
	gpu_mem_mb: 0, // 估算显存占用，用于放置决策（0 = 不按显存判断）
	machines: [], // 允许运行的机器 ID，空 = 全部
	require_token: false, // 观众需要分享链接令牌
	public: true, // 是否出现在门户页程序列表
	enabled: true,
	exe_overrides: {}, // 不同机器上的可执行文件路径 { 机器ID: 路径 }
	audio: true, // 传 -AudioMixer（UE 音频）
	max_bitrate_mbps: 0, // 编码最大码率（0 = UE 默认）
	min_bitrate_mbps: 0,
	inactive_release_sec: 0, // 观众无任何键鼠/触摸操作超过该时间自动断开（0 = 不限）
	one_session_per_ip: false, // 同一 IP 只保留最新一个会话
	allow_ips: [], // 只允许这些 IP/网段访问（空 = 不限）
	hide_cursor: false, // 播放页隐藏鼠标指针
	allow_commands: false, // 允许观众通过数据通道执行 UE 控制台命令（-AllowPixelStreamingCommands）。有安全风险，默认关闭
	prewarm_hours: "", // 预热时段，例如 "8-20"（空 = 全天）
	fresh_instance: false, // 每位观众使用全新实例：观众离开后立即关闭其实例、不再分配给下一位（仅独占模式；企业版 UserExitKillUe）
	vip_preempt: true, // 使用 VIP 访问链接的观众在程序满员时，断开观看时间最长的普通观众让出位置（企业版 vipAccess）
};

const PROGRAM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const STR_LIMITS = { name: 64, description: 500, exe: 1024, args: 4096, cwd: 1024 };

function normalizeProgram(input, existing = {}) {
	// 只保留已知字段（防止任意键写入数据库）
	const merged = { ...PROGRAM_DEFAULTS, ...existing, ...input };
	const p = { id: typeof merged.id === "string" ? merged.id.trim().toLowerCase() : merged.id }; // ID 统一小写（访问时大小写不敏感）
	for (const k of Object.keys(PROGRAM_DEFAULTS)) p[k] = merged[k];
	const errs = [];
	for (const [k, max] of Object.entries(STR_LIMITS)) {
		if (p[k] === null || p[k] === undefined) p[k] = "";
		if (typeof p[k] !== "string") errs.push(`${k} 必须是字符串`);
		else if (p[k].length > max) errs.push(`${k} 不能超过 ${max} 个字符`);
	}
	if (!PROGRAM_ID_RE.test(p.id || "")) errs.push("id 只能包含小写字母、数字、- 和 _，长度 1-32，以字母或数字开头");
	if (!String(p.name || "").trim()) p.name = p.id;
	if (!["auto", "4.27", "5", "5.52"].includes(String(p.ue_version))) errs.push("ue_version 取值：auto / 4.27 / 5 / 5.52");
	p.ue_version = String(p.ue_version);
	if (!["exclusive", "shared"].includes(p.mode)) errs.push("mode 取值：exclusive / shared");
	for (const k of ["max_viewers", "prewarm", "max_instances", "idle_release_sec", "startup_timeout_sec", "res_x", "res_y", "fps", "gpu_mem_mb", "max_bitrate_mbps", "min_bitrate_mbps", "inactive_release_sec"]) {
		p[k] = Number(p[k]);
		if (!Number.isFinite(p[k]) || p[k] < 0) errs.push(`${k} 必须是非负数`);
	}
	if (p.mode === "exclusive") p.max_viewers = 1;
	if (p.max_viewers < 1) errs.push("max_viewers 至少为 1");
	if (p.prewarm > p.max_instances) errs.push("prewarm 不能大于 max_instances");
	if (p.startup_timeout_sec < 10) errs.push("startup_timeout_sec 至少 10 秒");
	if (!Array.isArray(p.machines) || p.machines.some((m) => typeof m !== "string")) errs.push("machines 必须是机器 ID 数组");
	if (!p.exe_overrides || typeof p.exe_overrides !== "object" || Array.isArray(p.exe_overrides)) errs.push("exe_overrides 必须是 { 机器ID: 路径 } 对象");
	else for (const [k, v] of Object.entries(p.exe_overrides)) if (typeof v !== "string" || !v.trim()) delete p.exe_overrides[k];
	if (!Array.isArray(p.allow_ips) || p.allow_ips.some((x) => !/^[0-9a-fA-F.:/]+$/.test(String(x)))) errs.push("allow_ips 必须是 IP/CIDR 数组");
	if (p.prewarm_hours && !/^([01]?\d|2[0-4])-([01]?\d|2[0-4])$/.test(String(p.prewarm_hours))) errs.push('prewarm_hours 格式为 "起始小时-结束小时"，例如 "8-20"');
	if (p.max_bitrate_mbps && p.min_bitrate_mbps > p.max_bitrate_mbps) errs.push("最小码率不能大于最大码率");
	p.audio = !!p.audio;
	p.one_session_per_ip = !!p.one_session_per_ip;
	p.hide_cursor = !!p.hide_cursor;
	p.allow_commands = !!p.allow_commands;
	p.fresh_instance = p.mode === "exclusive" && !!p.fresh_instance; // 共享模式下多位观众同时使用一个实例，不适用
	p.vip_preempt = !!p.vip_preempt;
	p.require_token = !!p.require_token;
	p.public = !!p.public;
	p.enabled = !!p.enabled;
	if (errs.length) {
		const e = new Error(errs.join("；"));
		e.status = 400;
		throw e;
	}
	return p;
}

class Store {
	constructor(dataDir) {
		if (!DatabaseSync) throw new Error("需要 Node.js >= 22.13（内置 node:sqlite）");
		fs.mkdirSync(dataDir, { recursive: true });
		this.file = path.join(dataDir, "platform.sqlite3");
		this.db = new DatabaseSync(this.file);
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
		this.migrate();
		this.stmts = new Map();
		this.machineCache = new Map();
	}

	migrate() {
		this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
		const row = this.db.prepare("SELECT v FROM schema_version").get();
		let v = row ? row.v : 0;
		if (!row) this.db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
		for (; v < MIGRATIONS.length; v++) {
			this.db.exec("BEGIN");
			try {
				this.db.exec(MIGRATIONS[v]);
				this.db.prepare("UPDATE schema_version SET v = ?").run(v + 1);
				this.db.exec("COMMIT");
			} catch (e) {
				this.db.exec("ROLLBACK");
				throw e;
			}
		}
	}

	/** 在一个事务内执行 fn（出错整体回滚） */
	/** 事务；嵌套调用并入外层事务（外层回滚时一并回滚） */
	transaction(fn) {
		if (this.txDepth) return fn();
		this.txDepth = 1;
		this.db.exec("BEGIN");
		try {
			const r = fn();
			this.db.exec("COMMIT");
			return r;
		} catch (e) {
			this.db.exec("ROLLBACK");
			this.machineCache.clear();
			throw e;
		} finally {
			this.txDepth = 0;
		}
	}

	q(sql) {
		let s = this.stmts.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.stmts.set(sql, s);
		}
		return s;
	}

	close() {
		try {
			this.db.close();
		} catch {}
	}

	/* -------------------------------------------------------------- settings */
	getSetting(key, def = undefined) {
		const r = this.q("SELECT value FROM settings WHERE key = ?").get(key);
		return r ? JSON.parse(r.value) : def;
	}
	setSetting(key, value) {
		this.q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
	}

	/* ----------------------------------------------------------------- users */
	countUsers() {
		return this.q("SELECT COUNT(*) AS c FROM users").get().c;
	}
	listUsers() {
		return this.q("SELECT id, username, role, disabled, created_at, last_login_at, totp_secret FROM users ORDER BY id").all().map((r) => rowUser(r));
	}
	getUser(id) {
		const r = this.q("SELECT * FROM users WHERE id = ?").get(id);
		return r ? rowUser(r, true) : null;
	}
	getUserByName(username) {
		const r = this.q("SELECT * FROM users WHERE username = ?").get(username);
		return r ? rowUser(r, true) : null;
	}
	createUser({ username, password_hash, role }) {
		const r = this.q("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run(username, password_hash, role, Date.now());
		return this.getUser(Number(r.lastInsertRowid));
	}
	updateUser(id, fields) {
		const allowed = ["password_hash", "role", "disabled", "last_login_at", "token_version", "totp_secret"];
		const keys = Object.keys(fields).filter((k) => allowed.includes(k));
		if (!keys.length) return this.getUser(id);
		const vals = keys.map((k) => (typeof fields[k] === "boolean" ? +fields[k] : fields[k]));
		this.q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...vals, id);
		return this.getUser(id);
	}
	deleteUser(id) {
		return this.q("DELETE FROM users WHERE id = ?").run(id).changes > 0;
	}

	/* -------------------------------------------------------------- programs */
	listPrograms() {
		return this.q("SELECT * FROM programs ORDER BY id").all().map(rowProgram);
	}
	getProgram(id) {
		const r = this.q("SELECT * FROM programs WHERE id = ?").get(String(id ?? "").toLowerCase());
		return r ? rowProgram(r) : null;
	}
	createProgram(input) {
		const p = normalizeProgram(input);
		if (this.getProgram(p.id)) {
			const e = new Error(`程序 ${p.id} 已存在`);
			e.status = 409;
			throw e;
		}
		const now = Date.now();
		const { id, ...data } = p;
		this.q("INSERT INTO programs (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(data), now, now);
		return this.getProgram(id);
	}
	updateProgram(id, input) {
		const cur = this.getProgram(id);
		if (!cur) return null;
		id = cur.id;
		const p = normalizeProgram({ ...input, id }, cur);
		const { id: _, created_at, updated_at, ...data } = p;
		this.q("UPDATE programs SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), Date.now(), id);
		return this.getProgram(id);
	}
	deleteProgram(id) {
		return this.q("DELETE FROM programs WHERE id = ?").run(String(id ?? "").toLowerCase()).changes > 0;
	}

	/* -------------------------------------------------------------- machines */
	listMachines() {
		return this.q("SELECT * FROM machines ORDER BY id").all().map(rowMachine);
	}
	getMachine(id) {
		if (this.machineCache.has(id)) return this.machineCache.get(id);
		const r = this.q("SELECT * FROM machines WHERE id = ?").get(id);
		const m = r ? rowMachine(r) : null;
		this.machineCache.set(id, m);
		return m;
	}
	/** Agent 上线时登记/更新机器信息（不覆盖管理员设置的 name/enabled/max_instances/tags） */
	touchMachine(id, { host, info, name }) {
		this.machineCache.delete(id);
		const now = Date.now();
		const cur = this.getMachine(id);
		if (!cur) {
			this.q("INSERT INTO machines (id, name, host, info, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name || id, host || "", JSON.stringify(info || {}), now, now);
		} else {
			this.q("UPDATE machines SET host = ?, info = ?, last_seen_at = ? WHERE id = ?").run(host || cur.host, JSON.stringify(info || cur.info), now, id);
		}
		this.machineCache.delete(id); // 写入后失效，下面重新读取最新值
		return this.getMachine(id);
	}
	updateMachine(id, fields) {
		const cur = this.getMachine(id);
		if (!cur) return null;
		const next = {
			name: String(fields.name ?? cur.name ?? id).slice(0, 64),
			enabled: fields.enabled ?? cur.enabled,
			max_instances: fields.max_instances ?? cur.max_instances,
			tags: fields.tags ?? cur.tags,
			gpus_override: fields.gpus_override ?? cur.gpus_override,
		};
		const badGpu = !Array.isArray(next.gpus_override) || next.gpus_override.some((g) => !Number.isInteger(+g.index) || +g.index < 0 || !(+g.memTotalMB >= 0));
		if (!Array.isArray(next.tags) || next.tags.some((t) => typeof t !== "string") || !Number.isInteger(+next.max_instances) || +next.max_instances < 0 || badGpu) {
			const e = new Error("tags 必须是数组，max_instances 必须是非负整数，gpus_override 为 [{ index, name, memTotalMB }]");
			e.status = 400;
			throw e;
		}
		next.gpus_override = next.gpus_override.map((g) => ({ index: +g.index, name: String(g.name || `GPU ${g.index}`).slice(0, 64), memTotalMB: +g.memTotalMB || 0 }));
		this.machineCache.delete(id);
		this.q("UPDATE machines SET name = ?, enabled = ?, max_instances = ?, tags = ?, gpus_override = ? WHERE id = ?").run(String(next.name), +!!next.enabled, +next.max_instances, JSON.stringify(next.tags), JSON.stringify(next.gpus_override), id);
		return this.getMachine(id);
	}
	deleteMachine(id) {
		this.machineCache.delete(id);
		return this.q("DELETE FROM machines WHERE id = ?").run(id).changes > 0;
	}

	/* -------------------------------------------------------------- sessions */
	startSession(s) {
		this.q(
			"INSERT INTO sessions (id, program_id, instance_id, machine_id, client_ip, external, user_agent, share_link_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
		).run(s.id, s.program_id, s.instance_id || null, s.machine_id || null, s.client_ip, +!!s.external, s.user_agent || "", s.share_link_id || null, s.started_at || Date.now());
	}
	endSession(id, f) {
		this.q("UPDATE sessions SET ended_at = ?, end_reason = ?, avg_kbps = ?, avg_rtt_ms = ?, avg_fps = ?, transport = ?, instance_id = COALESCE(?, instance_id), machine_id = COALESCE(?, machine_id) WHERE id = ?").run(
			f.ended_at || Date.now(),
			f.end_reason || "",
			f.avg_kbps ?? null,
			f.avg_rtt_ms ?? null,
			f.avg_fps ?? null,
			f.transport || null,
			f.instance_id || null,
			f.machine_id || null,
			id
		);
	}
	/** 历史会话分页查询 */
	querySessions({ program, from, to, ip, limit = 50, offset = 0 } = {}) {
		const where = ["1=1"];
		const args = [];
		if (program) where.push("program_id = ?") && args.push(String(program).toLowerCase());
		if (from) where.push("started_at >= ?") && args.push(+from);
		if (to) where.push("started_at <= ?") && args.push(+to);
		if (ip) where.push("client_ip LIKE ?") && args.push(`%${ip}%`);
		const w = where.join(" AND ");
		const total = this.db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE ${w}`).get(...args).c;
		const rows = this.db
			.prepare(`SELECT * FROM sessions WHERE ${w} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
			.all(...args, clampInt(limit, 1, 500, 50), clampInt(offset, 0, 1e9, 0))
			.map((r) => ({ ...r, external: !!r.external }));
		return { total, rows };
	}
	/** 统计：每个程序的会话数、总时长（毫秒） */
	sessionStats(since) {
		return this.q(
			"SELECT program_id, COUNT(*) AS sessions, SUM(COALESCE(ended_at, ?) - started_at) AS total_ms, SUM(external) AS external FROM sessions WHERE started_at >= ? GROUP BY program_id"
		).all(Date.now(), since);
	}
	/** 进程异常退出时未结束的会话 */
	closeDanglingSessions() {
		return this.q("UPDATE sessions SET ended_at = started_at, end_reason = 'server restart' WHERE ended_at IS NULL").run().changes;
	}
	purgeHistory(retentionDays) {
		const cutoff = Date.now() - retentionDays * 86400 * 1000;
		const a = this.q("DELETE FROM sessions WHERE started_at < ?").run(cutoff).changes;
		const b = this.q("DELETE FROM audit WHERE ts < ?").run(cutoff).changes;
		return a + b;
	}

	/* ----------------------------------------------------------- share links */
	createShareLink({ id, program_id, note, expires_at, max_uses, created_by, vip = false }) {
		this.q("INSERT INTO share_links (id, program_id, note, expires_at, max_uses, created_by, created_at, vip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			id,
			program_id,
			note || "",
			expires_at || null,
			max_uses || 0,
			created_by || "",
			Date.now(),
			+!!vip
		);
		return this.getShareLink(id);
	}
	getShareLink(id) {
		const r = this.q("SELECT * FROM share_links WHERE id = ?").get(id);
		return r ? rowLink(r) : null;
	}
	listShareLinks() {
		return this.q("SELECT * FROM share_links ORDER BY created_at DESC LIMIT 500").all().map(rowLink);
	}
	useShareLink(id) {
		this.q("UPDATE share_links SET uses = uses + 1 WHERE id = ?").run(id);
	}
	revokeShareLink(id) {
		return this.q("UPDATE share_links SET revoked = 1 WHERE id = ?").run(id).changes > 0;
	}

	/* ------------------------------------------------------------ API 令牌 */
	createApiToken({ id, name, token_hash, role, created_by, expires_at }) {
		this.q("INSERT INTO api_tokens (id, name, token_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, name, token_hash, role, created_by || "", Date.now(), expires_at || null);
		return this.getApiToken(id);
	}
	getApiToken(id) {
		const r = this.q("SELECT * FROM api_tokens WHERE id = ?").get(id);
		return r ? { ...r, revoked: !!r.revoked } : null;
	}
	listApiTokens() {
		return this.q("SELECT id, name, role, created_by, created_at, expires_at, last_used_at, revoked FROM api_tokens ORDER BY created_at DESC").all().map((r) => ({ ...r, revoked: !!r.revoked }));
	}
	touchApiToken(id) {
		this.q("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
	}
	revokeApiToken(id) {
		return this.q("UPDATE api_tokens SET revoked = 1 WHERE id = ?").run(id).changes > 0;
	}

	/* ----------------------------------------------------------------- audit */
	audit(entry) {
		this.q("INSERT INTO audit (ts, username, ip, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
			Date.now(),
			entry.username || "",
			entry.ip || "",
			entry.action,
			entry.target || "",
			entry.detail ? JSON.stringify(entry.detail) : ""
		);
	}
	listAudit({ limit = 100, offset = 0, q = "" } = {}) {
		const n = clampInt(limit, 1, 500, 100);
		const off = clampInt(offset, 0, 1e9, 0);
		const kw = String(q || "").trim().slice(0, 64);
		if (!kw) return this.q("SELECT * FROM audit ORDER BY id DESC LIMIT ? OFFSET ?").all(n, off);
		const like = `%${kw.replace(/[%_!]/g, (c) => "!" + c)}%`; // 关键字中的通配符按字面匹配
		return this.q("SELECT * FROM audit WHERE username LIKE ? ESCAPE '!' OR action LIKE ? ESCAPE '!' OR target LIKE ? ESCAPE '!' OR ip LIKE ? ESCAPE '!' ORDER BY id DESC LIMIT ? OFFSET ?").all(like, like, like, like, n, off);
	}
	/** 导出会话（CSV 用），最多 max 行 */
	exportSessions({ program, from, to, ip } = {}, max = 100000) {
		const where = ["1=1"];
		const args = [];
		if (program) where.push("program_id = ?") && args.push(String(program).toLowerCase());
		if (from) where.push("started_at >= ?") && args.push(+from);
		if (to) where.push("started_at <= ?") && args.push(+to);
		if (ip) where.push("client_ip LIKE ?") && args.push(`%${ip}%`);
		return this.db.prepare(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ?`).all(...args, max);
	}
}

function clampInt(v, min, max, def) {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function rowUser(r, withHash = false) {
	const u = { id: r.id, username: r.username, role: r.role, disabled: !!r.disabled, created_at: r.created_at, last_login_at: r.last_login_at, totp: !!r.totp_secret };
	if (withHash) {
		u.password_hash = r.password_hash;
		u.token_version = r.token_version || 0;
		u.totp_secret = r.totp_secret || null;
	}
	return u;
}
function rowLink(r) {
	return { ...r, revoked: !!r.revoked, vip: !!r.vip };
}
function rowProgram(r) {
	return { id: r.id, ...PROGRAM_DEFAULTS, ...JSON.parse(r.data), created_at: r.created_at, updated_at: r.updated_at };
}
function rowMachine(r) {
	return { ...r, enabled: !!r.enabled, tags: JSON.parse(r.tags || "[]"), info: JSON.parse(r.info || "{}"), gpus_override: JSON.parse(r.gpus_override || "[]") };
}

module.exports = { Store, normalizeProgram, PROGRAM_DEFAULTS, PROGRAM_ID_RE };
