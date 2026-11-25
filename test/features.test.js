"use strict";
// 企业版功能覆盖 + 安全加固的集成测试
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { startPlatform, next, type, text, sleep } = require("./helpers.js");
const { totpCode } = require("../src/security.js");

let P;
test.before(async () => {
	P = await startPlatform();
	assert.strictEqual((await P.login()).status, 200);
});
test.after(() => P && P.stop());

test("session revocation: password change invalidates other sessions; logout-all", async () => {
	const oldCookie = P.cookie;
	assert.strictEqual((await P.api("POST", "/api/v1/auth/password", { oldPassword: "Admin12345", newPassword: "Admin12346" })).status, 200);
	assert.notStrictEqual(P.cookie, oldCookie, "current session re-issued");
	assert.strictEqual((await P.api("GET", "/api/v1/auth/me")).status, 200);
	assert.strictEqual((await P.api("GET", "/api/v1/auth/me", undefined, { headers: { Cookie: oldCookie }, auth: false })).status, 401, "old cookie revoked");
	// 第二个会话，然后"登出全部"
	const keep = P.cookie;
	assert.strictEqual((await P.api("POST", "/api/v1/auth/logout-all")).status, 200);
	assert.strictEqual((await P.api("GET", "/api/v1/auth/me", undefined, { headers: { Cookie: keep }, auth: false })).status, 401);
	assert.strictEqual((await P.login("admin", "Admin12346")).status, 200);
	await P.api("POST", "/api/v1/auth/password", { oldPassword: "Admin12346", newPassword: "Admin12345" });
});

test("two-factor login (TOTP): required after enabling; wrong/replayed code rejected", async () => {
	const setup = (await P.api("POST", "/api/v1/auth/totp/setup")).body;
	assert.match(setup.otpauth, /^otpauth:\/\/totp\//);
	assert.strictEqual((await P.api("POST", "/api/v1/auth/totp/enable", { code: "123456" })).status, 400);
	assert.strictEqual((await P.api("POST", "/api/v1/auth/totp/enable", { code: totpCode(setup.secret) })).status, 200);
	const noCode = await P.login();
	assert.strictEqual(noCode.status, 401);
	assert.strictEqual(noCode.body.totpRequired, true);
	assert.strictEqual((await P.login("admin", "Admin12345", "000000")).status, 401);
	const ok = await P.login("admin", "Admin12345", totpCode(setup.secret, Date.now() + 30000)); // 下一个时间窗（同一个码不可重放）
	assert.strictEqual(ok.status, 200);
	assert.strictEqual(ok.body.user.totp, true);
	assert.strictEqual((await P.api("POST", "/api/v1/auth/totp/disable", { password: "Admin12345" })).status, 200);
	assert.strictEqual((await P.login()).status, 200, "login works without code again");
});

test("API tokens: bearer auth by role, CSRF-exempt, cannot touch account endpoints, revocable; CORS", async () => {
	const viewer = (await P.api("POST", "/api/v1/api-tokens", { name: "大屏", role: "viewer", days: 30 })).body;
	const operator = (await P.api("POST", "/api/v1/api-tokens", { name: "业务系统", role: "operator" })).body;
	const admin = (await P.api("POST", "/api/v1/api-tokens", { name: "运维脚本", role: "admin" })).body;
	assert.match(viewer.token, /^psk_[0-9a-f]{12}_/);
	const bearer = (t) => ({ headers: { Authorization: `Bearer ${t}` }, auth: false });
	assert.strictEqual((await P.api("GET", "/api/v1/programs", undefined, bearer(viewer.token))).status, 200);
	assert.strictEqual((await P.api("POST", "/api/v1/programs", { id: "via-viewer" }, bearer(viewer.token))).status, 403);
	assert.strictEqual((await P.api("POST", "/api/v1/programs", { id: "via-token", name: "令牌创建" }, bearer(operator.token))).status, 201, "no X-PS-Request needed");
	assert.strictEqual((await P.api("GET", "/api/v1/users", undefined, bearer(admin.token))).status, 200);
	assert.strictEqual((await P.api("POST", "/api/v1/users", { username: "x1", password: "Passw0rd1", role: "viewer" }, bearer(admin.token))).status, 403, "account changes need a real login");
	assert.strictEqual((await P.api("GET", "/api/v1/programs", undefined, bearer(viewer.token.slice(0, -2) + "zz"))).status, 401);
	await P.api("DELETE", `/api/v1/api-tokens/${viewer.id}`);
	assert.strictEqual((await P.api("GET", "/api/v1/programs", undefined, bearer(viewer.token))).status, 401, "revoked");
	const list = (await P.api("GET", "/api/v1/api-tokens")).body;
	assert.ok(list.every((t) => !("token_hash" in t)), "hashes never returned");

	await P.api("PUT", "/api/v1/settings", { security: { corsOrigins: ["https://app.example.com"] } });
	const pre = await P.api("OPTIONS", "/api/v1/programs", undefined, { headers: { Origin: "https://app.example.com" }, auth: false });
	assert.strictEqual(pre.status, 204);
	assert.strictEqual(pre.headers["access-control-allow-origin"], "https://app.example.com");
	assert.strictEqual((await P.api("OPTIONS", "/api/v1/programs", undefined, { headers: { Origin: "https://evil.example" }, auth: false })).status, 403);
	assert.strictEqual((await P.api("PUT", "/api/v1/settings", { security: { corsOrigins: ["not a url"] } })).status, 400);
});

test("tool APIs are enterprise compatible; public only when enabled", async () => {
	const body = { CoordinateA1: { x: 0, y: 0 }, CoordinateA2: { x: 10, y: 0 }, CoordinateB1: { x: 0, y: 0 }, CoordinateB2: { x: 20, y: 0 }, CoordinateA: [{ x: 5, y: 5 }] };
	assert.strictEqual((await P.request(P.PUB, "POST", "/api/coordinatecovert", { body })).status, 404, "not public by default");
	const r = await P.api("POST", "/api/coordinatecovert", body);
	assert.deepStrictEqual(r.body.CoordinateB, [{ x: 10, y: 10 }]);
	assert.strictEqual(r.body.status, 0);
	const bad = await P.api("POST", "/api/pathfinder", { roadNet: { points: [], lines: [] }, routingPoints: [] });
	assert.strictEqual(bad.body.status, -1, "business error as status=-1 like enterprise");
	await P.api("PUT", "/api/v1/settings", { security: { publicTools: true } });
	const pub = await P.request(P.PUB, "POST", "/api/v1/tools/coordinate", { body, auth: false });
	assert.strictEqual(pub.status, 200);
	await P.api("PUT", "/api/v1/settings", { security: { publicTools: false } });
});

test("viewer rules: IP allowlist (global & per program), one session per IP, inactivity release, player config", async () => {
	await P.api("POST", "/api/v1/programs", { id: "rules", name: "规则", mode: "shared", max_viewers: 10, one_session_per_ip: true, inactive_release_sec: 60, hide_cursor: true, allow_ips: ["198.51.100.0/24", "10.0.0.0/8"] });
	const denied = await P.player("/play/rules", { "X-Forwarded-For": "203.0.113.5" });
	assert.match(await next(denied, text), /不允许/);
	assert.strictEqual(await denied.closed, 4006);

	const a = await P.player("/play/rules", { "X-Forwarded-For": "198.51.100.7" });
	const cfg = await next(a, type("playerConfig"));
	assert.strictEqual(cfg.hideCursor, true);
	assert.strictEqual((await next(a, type("setmouseReleaseTime"))).mouseReleaseTime, 60);
	const b = await P.player("/play/rules", { "X-Forwarded-For": "198.51.100.7" });
	assert.match(await next(a, text), /已在其它页面打开/);
	assert.strictEqual(await a.closed, 4005, "older session replaced");
	b.send(JSON.stringify({ type: "mouseRelease" }));
	assert.match(await next(b, text), /长时间未操作/);
	assert.strictEqual(await b.closed, 4002);

	await P.api("PUT", "/api/v1/settings", { security: { viewerAllow: ["10.0.0.0/8"] } });
	const g = await P.player("/play/rules", { "X-Forwarded-For": "198.51.100.8" });
	assert.strictEqual(await g.closed, 4006, "global allowlist also enforced");
	await P.api("PUT", "/api/v1/settings", { security: { viewerAllow: [] } });
});

test("placement: per-machine exe paths and estimated memory on manually defined GPUs", async () => {
	const x = await P.agent("render-x");
	const y = await P.agent("render-y");
	await P.api("POST", "/api/v1/programs", { id: "multi", exe: "", exe_overrides: { "render-x": "D:\\X\\factory.exe" }, mode: "exclusive", max_instances: 2 });
	const p1 = await P.player("/play/multi");
	const s = await next(x, type("start"));
	assert.strictEqual(s.exe, "D:\\X\\factory.exe");
	await sleep(200);
	assert.ok(!y.inbox.some(type("start")), "machine without a path is never chosen");
	p1.close();

	const z = await P.agent("render-z"); // 不上报 GPU（例如国产显卡）
	assert.strictEqual((await P.api("PUT", "/api/v1/machines/render-z", { gpus_override: [{ index: 0, name: "国产卡A", memTotalMB: 8000 }, { index: 1, name: "国产卡B", memTotalMB: 8000 }] })).status, 200);
	await P.api("POST", "/api/v1/programs", { id: "est", exe: "D:\\est.exe", machines: ["render-z"], mode: "exclusive", max_instances: 5, gpu_mem_mb: 5000 });
	const q1 = await P.player("/play/est");
	const z1 = await next(z, type("start"));
	const q2 = await P.player("/play/est");
	const z2 = await next(z, type("start"));
	assert.deepStrictEqual([z1.args.find((a) => a.startsWith("-graphicsadapter")), z2.args.find((a) => a.startsWith("-graphicsadapter"))].sort(), ["-graphicsadapter=0", "-graphicsadapter=1"], "second instance goes to the other card");
	const q3 = await P.player("/play/est");
	await next(q3, type("playerqueue"));
	await sleep(300);
	assert.ok(!z.inbox.some(type("start")), "no card has 5000MB left → queued instead of overcommitting");
	const prog = (await P.api("GET", "/api/v1/programs")).body.find((p) => p.id === "est");
	assert.match(prog.runtime.lastError, /没有可用/);
	for (const w of [q1, q2, q3, x, y, z]) w.close();
});

test("backup/restore, log viewer, connection rate limit, custom site hosting", async () => {
	const backup = (await P.api("GET", "/api/v1/backup")).body;
	assert.strictEqual(backup.kind, "ps-platform-backup");
	assert.ok(backup.programs.find((p) => p.id === "rules"));
	await P.api("DELETE", "/api/v1/programs/rules");
	const r = await P.api("POST", "/api/v1/restore", backup);
	assert.strictEqual(r.status, 200);
	assert.ok((await P.api("GET", "/api/v1/programs/rules")).status === 200, "restored");
	assert.strictEqual((await P.api("POST", "/api/v1/restore", { foo: 1 })).status, 400);

	const logs = (await P.api("GET", "/api/v1/logs?q=" + encodeURIComponent("拒绝观众"))).body;
	assert.ok(logs.length >= 1 && logs[0].level === "warn", JSON.stringify(logs.slice(0, 2)));

	await P.api("PUT", "/api/v1/settings", { security: { rateLimit: { wsPerSec: 1, wsBurst: 2 } } });
	const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => P.player("/play/rules")));
	assert.ok(results.some((x) => x.status === "rejected" && /429/.test(x.reason.message)), "flood is throttled");
	results.forEach((x) => x.status === "fulfilled" && x.value.close());
	await P.api("PUT", "/api/v1/settings", { security: { rateLimit: { wsPerSec: 5, wsBurst: 20 } } });

	fs.writeFileSync(path.join(P.config.site.dir, "custom.html"), "<h1>my page</h1>");
	assert.match((await P.request(P.PUB, "GET", "/custom.html")).text, /my page/);
	fs.writeFileSync(path.join(P.config.site.dir, "index.html"), "<h1>my portal</h1>");
	assert.match((await P.request(P.PUB, "GET", "/")).text, /my portal/);
	assert.strictEqual((await P.request(P.PUB, "GET", "/../config.json")).status, 404);
});
