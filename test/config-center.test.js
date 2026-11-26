"use strict";
// 配置中心：优先级（环境变量 > 管理端 > 默认）、config.json 迁移、环境变量锁定与沉淀、校验、立即生效 / 重启生效、版本冲突、恢复默认、写入失败、接口权限与防锁死
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig } = require("../src/config.js");
const { Store } = require("../src/store.js");
const { ConfigCenter, MANAGED } = require("../src/config-center.js");
const { startPlatform, sleep } = require("./helpers.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "psp-cfg-"));
/** 模拟一次平台启动：读取 config.json + 环境变量，打开数据库，载入配置中心 */
function boot(dir, { env = {}, file } = {}) {
	if (file !== undefined) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(file));
	const config = loadConfig({ baseDir: dir, env });
	const store = new Store(config.dataDir);
	const cc = new ConfigCenter({ store, config, env });
	return { config, store, cc, close: () => store.close() };
}
const item = (cc, key) => cc.view().items.find((i) => i.key === key);

test("配置中心：默认值、来源与只读的启动参数", () => {
	const dir = tmp();
	const b = boot(dir);
	try {
		const v = b.cc.view();
		assert.strictEqual(v.items.length, MANAGED.length);
		assert.ok(v.items.every((i) => i.source === "default" && !i.locked && !i.pending));
		assert.strictEqual(v.rev, 0);
		assert.strictEqual(b.config.log.level, "info");
		assert.deepStrictEqual(item(b.cc, "security.adminAllow").value, ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
		const port = v.bootstrap.find((x) => x.key === "http.port");
		assert.strictEqual(port.value, 88);
		assert.strictEqual(port.source, "default");
		assert.match(b.cc.describe(), /security\.adminAllow/);
	} finally {
		b.close();
	}
});

test("配置中心：config.json 中的托管参数升级时导入一次，之后以管理端为准并提示文件已失效", () => {
	const dir = tmp();
	let b = boot(dir, { file: { http: { port: 9088 }, log: { level: "debug" }, security: { engineAllow: ["10.1.0.0/16"] }, history: { retentionDays: 30 } } });
	try {
		assert.strictEqual(b.config.log.level, "debug");
		assert.deepStrictEqual(b.config.security.engineAllow, ["10.1.0.0/16"]);
		assert.strictEqual(item(b.cc, "log.level").source, "admin");
		assert.strictEqual(item(b.cc, "log.level").imported, "config.json");
		assert.ok(b.cc.notes.some(([, m]) => /导入管理端/.test(m)));
		assert.strictEqual(b.cc.view().bootstrap.find((x) => x.key === "http.port").source, "config.json");
		// 管理端修改
		b.cc.update({ "log.level": "warn" }, { rev: b.cc.meta.rev });
	} finally {
		b.close();
	}
	// 再次启动：config.json 仍写着 debug，但以管理端保存的 warn 为准，并提示
	b = boot(dir, { file: { http: { port: 9088 }, log: { level: "debug" }, security: { engineAllow: ["10.1.0.0/16"] }, history: { retentionDays: 30 } } });
	try {
		assert.strictEqual(b.config.log.level, "warn");
		assert.deepStrictEqual(b.cc.staleFileKeys(), ["log.level"]);
		assert.ok(b.cc.view().warnings.some((w) => /log\.level/.test(w)));
		assert.ok(!b.cc.notes.some(([, m]) => /导入管理端/.test(m)), "只导入一次");
	} finally {
		b.close();
	}
});

test("配置中心：环境变量锁定（管理端只读），其值被保存，删除环境变量后沿用", () => {
	const dir = tmp();
	let b = boot(dir, { env: { PS_LOG_LEVEL: "error", PS_ADMIN_ALLOW: "10.0.0.0/8, 192.168.5.0/24", PS_UE_HOST: "" } });
	try {
		assert.strictEqual(b.config.log.level, "error");
		const it = item(b.cc, "log.level");
		assert.strictEqual(it.locked, true);
		assert.strictEqual(it.source, "env");
		assert.strictEqual(it.env, "PS_LOG_LEVEL");
		assert.throws(() => b.cc.update({ "log.level": "info" }), (e) => e.status === 409 && /PS_LOG_LEVEL/.test(e.message));
		assert.throws(() => b.cc.reset(["log.level"]), (e) => e.status === 409);
		assert.deepStrictEqual(b.config.security.adminAllow, ["10.0.0.0/8", "192.168.5.0/24"]);
		assert.strictEqual(item(b.cc, "gateway.ueHost").locked, false, "空的环境变量视为未设置");
	} finally {
		b.close();
	}
	b = boot(dir); // 删除了环境变量
	try {
		assert.strictEqual(b.config.log.level, "error");
		assert.strictEqual(item(b.cc, "log.level").source, "admin");
		assert.strictEqual(item(b.cc, "log.level").locked, false);
		assert.deepStrictEqual(b.config.security.adminAllow, ["10.0.0.0/8", "192.168.5.0/24"]);
	} finally {
		b.close();
	}
	// 允许为空的环境变量：PS_RELEASE_BASE_URL="" = 锁定为不提供一键获取
	b = boot(tmp(), { env: { PS_RELEASE_BASE_URL: "" } });
	try {
		assert.strictEqual(item(b.cc, "downloads.releaseBaseUrl").locked, true);
		assert.strictEqual(b.config.downloads.releaseBaseUrl, "");
	} finally {
		b.close();
	}
	// 不合法的环境变量：启动失败并指明变量名
	assert.throws(() => boot(tmp(), { env: { PS_UE_HOST: "bad host" } }), /PS_UE_HOST/);
});

test("配置中心：校验、立即生效 / 重启生效、版本冲突、恢复默认", () => {
	const dir = tmp();
	let b = boot(dir);
	try {
		const cc = b.cc;
		for (const [values, re] of [
			[{ "security.engineAllow": "10.0.0.0/8, 300.1.1.1" }, /UE \/ Agent 允许网段：不是合法的 IP/],
			[{ "security.adminAllow": "" }, /至少填写一个/],
			[{ "security.engineAllow": "10.0.0.0/33" }, /不是合法/],
			[{ "security.trustProxy": "10.0.0.0/8" }, /不是合法的 IP 地址/],
			[{ "log.level": "verbose" }, /日志级别/],
			[{ "history.retentionDays": 0 }, /1–3650/],
			[{ "localAgent.allowExe": "UE\\Game" }, /完整路径/],
			[{ "gateway.ueHost": "a b" }, /auto/],
			[{ "turn.builtin.enable": true, "turn.builtin.minPort": 50000, "turn.builtin.maxPort": 40000 }, /中继端口起不能大于/],
			[{ "nope.key": 1 }, /未知的参数/],
		]) assert.throws(() => cc.update(values), (e) => e.status === 400 && re.test(e.message), JSON.stringify(values));

		// 立即生效：写回 config 并通知
		const seen = [];
		cc.on("change", (c) => seen.push(c.key));
		let r = cc.update({ "log.level": "debug", "security.lanNetworks": "100.64.0.0/10\n100.64.0.0/10", "localAgent.allowExe": "D:\\UE\\;/opt/ue/" }, { rev: 0, by: "admin" });
		assert.strictEqual(r.changes.length, 3);
		assert.strictEqual(b.config.log.level, "debug");
		assert.deepStrictEqual(b.config.security.lanNetworks, ["100.64.0.0/10"], "去重");
		assert.deepStrictEqual(seen.sort(), ["log.level", "security.lanNetworks"]);
		assert.strictEqual(cc.meta.rev, 1);
		assert.strictEqual(item(cc, "log.level").updated.by, "admin");

		// 重启生效：保存但本次运行不变，标记待重启
		assert.deepStrictEqual(b.config.localAgent.allowExe, []);
		assert.strictEqual(item(cc, "localAgent.allowExe").pending, true);
		assert.deepStrictEqual(item(cc, "localAgent.allowExe").value, ["D:\\UE", "/opt/ue"], "去掉末尾的分隔符");
		r = cc.update({ "gateway.ueHost": "192.168.1.10:88" }, { rev: 1 });
		assert.strictEqual(b.config.gateway.ueHost, "auto");
		assert.strictEqual(cc.pendingCount(), 2);

		// 版本冲突、相同值不产生修改
		assert.throws(() => cc.update({ "log.level": "warn" }, { rev: 1 }), (e) => e.status === 409);
		assert.strictEqual(cc.update({ "log.level": "debug" }, { rev: 2 }).changes.length, 0);

		// 恢复默认
		r = cc.reset(["log.level"], { rev: 2 });
		assert.strictEqual(r.changes[0].to, "info");
		assert.strictEqual(b.config.log.level, "info");
		assert.strictEqual(item(cc, "log.level").source, "default");
	} finally {
		b.close();
	}
	// 重启后：重启生效的项已生效
	b = boot(dir);
	try {
		assert.strictEqual(b.config.gateway.ueHost, "192.168.1.10:88");
		assert.deepStrictEqual(b.config.localAgent.allowExe, ["D:\\UE", "/opt/ue"]);
		assert.strictEqual(b.cc.pendingCount(), 0);
		assert.strictEqual(b.cc.meta.rev, 3);
	} finally {
		b.close();
	}
});

test("配置中心：写入失败时内存不变；数据库中不合法的值被忽略", () => {
	const dir = tmp();
	let b = boot(dir);
	try {
		const orig = b.store.setSetting.bind(b.store);
		b.store.setSetting = () => {
			throw new Error("disk full");
		};
		assert.throws(() => b.cc.update({ "log.level": "debug" }), /disk full/);
		assert.strictEqual(b.config.log.level, "info");
		assert.strictEqual(b.cc.meta.rev, 0);
		b.store.setSetting = orig;
		// 手工写入不合法的值（例如版本回退、直接改数据库）
		b.store.setSetting("config.values", { "log.level": "loud", "history.retentionDays": 15, "future.key": 1 });
	} finally {
		b.close();
	}
	b = boot(dir);
	try {
		assert.strictEqual(b.config.log.level, "info");
		assert.strictEqual(b.config.history.retentionDays, 15);
		assert.ok(b.cc.notes.some(([lv, m]) => lv === "warn" && /log\.level 不合法/.test(m)));
	} finally {
		b.close();
	}
});

test("系统参数接口：权限、审计、立即生效、防止把自己锁在管理端外、备份与恢复", async () => {
	const ctx = await startPlatform();
	try {
		await ctx.login();
		let r = await ctx.api("GET", "/api/v1/config");
		assert.strictEqual(r.status, 200);
		assert.ok(Array.isArray(r.body.items) && Array.isArray(r.body.bootstrap) && Array.isArray(r.body.groups));
		const rev = r.body.rev;
		assert.strictEqual(r.body.items.find((i) => i.key === "localAgent.enable").value, false, "测试环境的 overrides 视为初始值");

		// 立即生效：会话有效期影响之后登录的 Cookie
		r = await ctx.api("PUT", "/api/v1/config", { rev, values: { "security.sessionTtlHours": 2, "log.level": "debug" } });
		assert.strictEqual(r.status, 200, r.text);
		assert.strictEqual(r.body.changes.length, 2);
		assert.strictEqual(ctx.config.security.sessionTtlHours, 2);
		await ctx.login();
		const login = await ctx.api("POST", "/api/v1/auth/login", { username: "admin", password: "Admin12345" });
		assert.match(login.headers["set-cookie"].join(";"), /Max-Age=7200/);

		// 版本冲突、格式错误
		assert.strictEqual((await ctx.api("PUT", "/api/v1/config", { rev, values: { "log.level": "warn" } })).status, 409);
		r = await ctx.api("GET", "/api/v1/config");
		const rev2 = r.body.rev;
		r = await ctx.api("PUT", "/api/v1/config", { rev: rev2, values: { "security.engineAllow": "x.y" } });
		assert.strictEqual(r.status, 400);

		// 防锁死：当前从 127.0.0.1 访问，保存后不在允许网段 → 拒绝
		r = await ctx.api("PUT", "/api/v1/config", { rev: rev2, values: { "security.adminAllow": "10.9.9.0/24" } });
		assert.strictEqual(r.status, 409);
		assert.match(r.body.error, /127\.0\.0\.1 将无法访问管理端/);
		r = await ctx.api("PUT", "/api/v1/config", { rev: rev2, values: { "security.adminAllow": "127.0.0.0/8, 10.9.9.0/24" } });
		assert.strictEqual(r.status, 200, r.text);

		// 立即生效：经本机代理来自 10.9.9.7 的请求（在上面保存的网段内），修改允许网段后立即被拒绝；恢复默认后恢复
		const viaProxy = { headers: { "X-Forwarded-For": "10.9.9.7" } };
		assert.strictEqual((await ctx.api("GET", "/api/v1/config", undefined, viaProxy)).status, 200);
		r = await ctx.api("PUT", "/api/v1/config", { rev: r.body.rev, values: { "security.adminAllow": "127.0.0.0/8, 192.168.0.0/16" } });
		assert.strictEqual(r.status, 200);
		assert.strictEqual((await ctx.api("GET", "/api/v1/config", undefined, viaProxy)).status, 403);
		r = await ctx.api("POST", "/api/v1/config/reset", { rev: r.body.rev, keys: ["security.adminAllow"] });
		assert.strictEqual(r.status, 200);
		assert.strictEqual((await ctx.api("GET", "/api/v1/config", undefined, viaProxy)).status, 200);
		// 本机回环地址始终允许以 Agent 身份接入（即使不在「UE / Agent 允许接入的网段」中）
		r = await ctx.api("PUT", "/api/v1/config", { rev: r.body.rev, values: { "security.engineAllow": "10.0.0.0/8" } });
		assert.strictEqual(r.status, 200);
		const ws = await ctx.agent("cfg-test");
		ws.close();

		// 重启生效的项显示为待重启，并出现在概览中
		r = await ctx.api("PUT", "/api/v1/config", { rev: r.body.rev, values: { "turn.builtin.minPort": 41000, "turn.builtin.maxPort": 41100 } });
		assert.strictEqual(r.status, 200);
		assert.strictEqual(r.body.pendingRestart, 2);
		assert.strictEqual((await ctx.api("GET", "/api/v1/overview")).body.config.pendingRestart, 2);

		// 审计
		const audit = await ctx.api("GET", "/api/v1/audit?limit=50");
		const rows = audit.body.items || audit.body;
		const upd = rows.find((a) => a.action === "config.update" && /log\.level/.test(a.target));
		assert.ok(upd, "config.update");
		assert.ok(rows.some((a) => a.action === "config.reset"));

		// 备份包含系统参数；恢复时校验并应用
		const bak = await ctx.api("GET", "/api/v1/backup");
		assert.strictEqual(bak.body.config["log.level"], "debug");
		bak.body.config["history.retentionDays"] = 45;
		r = await ctx.api("POST", "/api/v1/restore", bak.body);
		assert.strictEqual(r.status, 200, r.text);
		assert.strictEqual(ctx.config.history.retentionDays, 45);
		bak.body.config["history.retentionDays"] = -1;
		r = await ctx.api("POST", "/api/v1/restore", bak.body);
		assert.strictEqual(r.status, 400);
		assert.strictEqual(ctx.config.history.retentionDays, 45, "恢复失败时整体回滚");

		// 权限：只读 / 运维账号不能查看；API 令牌不能修改
		await ctx.api("POST", "/api/v1/users", { username: "ops", password: "Ops12345678", role: "operator" });
		const t = await ctx.api("POST", "/api/v1/api-tokens", { name: "cfg", role: "admin", days: 1 });
		const bearer = { Authorization: `Bearer ${t.body.token}` };
		assert.strictEqual((await ctx.request(ctx.ADMIN, "GET", "/api/v1/config", { headers: bearer })).status, 200);
		assert.strictEqual((await ctx.request(ctx.ADMIN, "PUT", "/api/v1/config", { headers: bearer, body: { values: { "log.level": "info" } } })).status, 403);
		await ctx.login("ops", "Ops12345678");
		assert.strictEqual((await ctx.api("GET", "/api/v1/config")).status, 403);
		assert.strictEqual((await ctx.api("PUT", "/api/v1/config", { values: { "log.level": "info" } })).status, 403);
	} finally {
		await ctx.stop();
	}
});
