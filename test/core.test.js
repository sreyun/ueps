"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store.js");
const auth = require("../src/auth.js");
const { loadConfig } = require("../src/config.js");
const { splitArgs, newId } = require("../src/util.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "psp-"));

test("auth: scrypt hash/verify, JWT sign/verify/expiry/tamper, roles, limiter", () => {
	const h = auth.hashPassword("Secret123");
	assert.ok(auth.verifyPassword("Secret123", h));
	assert.ok(!auth.verifyPassword("secret123", h));
	assert.ok(!auth.verifyPassword("x", "garbage"));
	assert.strictEqual(auth.checkPasswordPolicy("short1"), "口令至少 8 位");
	assert.ok(auth.checkPasswordPolicy("onlyletters"));
	assert.strictEqual(auth.checkPasswordPolicy("letters123"), null);

	const t = auth.signJwt({ sub: 1, role: "admin" }, "k", 60);
	assert.strictEqual(auth.verifyJwt(t, "k").role, "admin");
	assert.strictEqual(auth.verifyJwt(t, "other"), null);
	const [h1, b1, s1] = t.split(".");
	const forged = Buffer.from(JSON.stringify({ sub: 1, role: "admin", exp: 9999999999 })).toString("base64url");
	assert.strictEqual(auth.verifyJwt(`${h1}.${forged}.${s1}`, "k"), null);
	assert.strictEqual(auth.verifyJwt(auth.signJwt({ a: 1 }, "k", -1), "k"), null, "expired");
	const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	assert.strictEqual(auth.verifyJwt(`${none}.${b1}.`, "k"), null, "alg none rejected");

	assert.ok(auth.hasRole("admin", "operator"));
	assert.ok(!auth.hasRole("viewer", "operator"));
	assert.ok(!auth.hasRole(undefined, "viewer"));

	const lim = new auth.LoginLimiter({ maxFails: 3, lockMs: 1000 });
	lim.fail("1.1.1.1");
	lim.fail("1.1.1.1");
	assert.strictEqual(lim.isLocked("1.1.1.1"), 0);
	lim.fail("1.1.1.1");
	assert.ok(lim.isLocked("1.1.1.1") > 0);
	lim.success("1.1.1.1");
	assert.strictEqual(lim.isLocked("1.1.1.1"), 0);
});

test("store: migrations, users, programs (validation), machines, sessions, share links, audit, settings", () => {
	const dir = tmp();
	const s = new Store(dir);
	assert.strictEqual(s.countUsers(), 0);
	const u = s.createUser({ username: "admin", password_hash: "x", role: "admin" });
	assert.strictEqual(u.username, "admin");
	assert.strictEqual(s.listUsers()[0].password_hash, undefined, "list never exposes hashes");
	s.updateUser(u.id, { disabled: true });
	assert.strictEqual(s.getUser(u.id).disabled, true);

	assert.throws(() => s.createProgram({ id: "Bad Id" }), /id 只能/);
	assert.throws(() => s.createProgram({ id: "demo", mode: "weird" }), /mode/);
	const p = s.createProgram({ id: "demo", name: "演示", exe: "C:\\UE\\demo.exe", mode: "shared", max_viewers: 5, prewarm: 1 });
	assert.strictEqual(p.max_viewers, 5);
	assert.strictEqual(p.res_x, 1920, "defaults applied");
	assert.throws(() => s.createProgram({ id: "demo" }), /已存在/);
	const p2 = s.updateProgram("demo", { mode: "exclusive", max_viewers: 9 });
	assert.strictEqual(p2.max_viewers, 1, "exclusive forces 1 viewer");
	assert.strictEqual(p2.exe, "C:\\UE\\demo.exe", "partial update keeps other fields");
	assert.throws(() => s.updateProgram("demo", { prewarm: 10, max_instances: 2 }), /prewarm/);

	const m = s.touchMachine("render-01", { host: "192.168.1.21", info: { gpus: 2 } });
	assert.strictEqual(m.enabled, true);
	s.updateMachine("render-01", { name: "渲染机1", max_instances: 3 });
	const m2 = s.touchMachine("render-01", { host: "192.168.1.22", info: { gpus: 2 } });
	assert.strictEqual(m2.name, "渲染机1", "agent re-register keeps admin fields");
	assert.strictEqual(m2.host, "192.168.1.22");

	s.startSession({ id: "s1", program_id: "demo", client_ip: "1.2.3.4", external: true });
	s.endSession("s1", { end_reason: "closed", avg_kbps: 4000, transport: "relay/tcp" });
	const q = s.querySessions({ program: "demo" });
	assert.strictEqual(q.total, 1);
	assert.strictEqual(q.rows[0].external, true);
	assert.strictEqual(s.sessionStats(0)[0].sessions, 1);

	s.createShareLink({ id: "L1", program_id: "demo", max_uses: 2 });
	s.useShareLink("L1");
	assert.strictEqual(s.getShareLink("L1").uses, 1);
	s.revokeShareLink("L1");
	assert.strictEqual(s.getShareLink("L1").revoked, true);

	s.audit({ username: "admin", action: "program.create", target: "demo", detail: { a: 1 } });
	assert.strictEqual(s.listAudit()[0].action, "program.create");
	s.setSetting("x", { y: [1, 2] });
	assert.deepStrictEqual(s.getSetting("x"), { y: [1, 2] });
	s.close();

	// 重新打开：迁移幂等、数据仍在
	const s2 = new Store(dir);
	assert.strictEqual(s2.getProgram("demo").name, "演示");
	s2.close();
});

test("config: defaults, file + env override, validation", () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ http: { port: 9000 }, security: { maxPlayersPerIp: 3 } }));
	const c = loadConfig({ baseDir: dir, env: { PS_PUBLIC_PORT: "9001", TURN_BUILTIN: "true", PS_ADMIN_ALLOW: "10.0.0.0/8, 127.0.0.1" } });
	assert.strictEqual(c.http.port, 9000);
	assert.strictEqual(c.http.publicPort, 9001);
	assert.strictEqual(c.http.host, "0.0.0.0", "nested defaults kept");
	assert.strictEqual(c.turn.builtin.enable, true);
	assert.deepStrictEqual(c.security.adminAllow, ["10.0.0.0/8", "127.0.0.1"]);
	assert.strictEqual(c.security.maxPlayersPerIp, 3);
	assert.ok(path.isAbsolute(c.dataDir));
	assert.throws(() => loadConfig({ baseDir: dir, env: { PS_PORT: "9001", PS_PUBLIC_PORT: "9001" } }), /不能相同/);
});

test("util: splitArgs handles quotes; ids are url-safe", () => {
	assert.deepStrictEqual(splitArgs('-A=1 "-Path=C:\\Program Files\\x" -B'), ["-A=1", "-Path=C:\\Program Files\\x", "-B"]);
	assert.match(newId(), /^[a-z0-9]{10}$/);
});
