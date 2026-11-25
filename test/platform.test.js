"use strict";
// 平台集成测试：node --test test/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { loadConfig } = require("../src/config.js");
const { createApp } = require("../src/app.js");
const { createLogger } = require("../src/logger.js");

const ROOT = path.join(__dirname, "..");
const BASE = 21000 + Math.floor(Math.random() * 2000);
const ADMIN = BASE;
const PUB = BASE + 1;
let app;
let cookie = "";
let agentToken;

/* ------------------------------------------------------------------ helpers */
function request(port, method, p, { body, headers = {}, auth = true } = {}) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const h = { ...headers };
		if (data) h["Content-Type"] = "application/json";
		if (method !== "GET") h["X-PS-Request"] = h["X-PS-Request"] ?? "1";
		if (auth && cookie) h.Cookie = cookie;
		const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
			// 像浏览器一样跟随会话 Cookie 的更新（改口令后旧会话会被吊销并下发新会话）
			const sc = (res.headers["set-cookie"] || []).find((c) => c.startsWith("ps_session="));
			if (auth && cookie && sc && !/^ps_session=;/.test(sc)) cookie = sc.split(";")[0];
			let buf = "";
			res.on("data", (c) => (buf += c));
			res.on("end", () => {
				let json = null;
				try {
					json = JSON.parse(buf);
				} catch {}
				resolve({ status: res.statusCode, body: json, text: buf, headers: res.headers });
			});
		});
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
}
const api = (method, p, body, opts = {}) => request(ADMIN, method, p, { body, ...opts });

function wsClient(url, protocol, headers = {}) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, protocol, { headers });
		ws.inbox = [];
		ws.waiters = [];
		ws.on("message", (d) => {
			const s = d.toString();
			let m;
			try {
				m = JSON.parse(s);
			} catch {
				m = s;
			}
			const i = ws.waiters.findIndex((w) => w.pred(m));
			if (i >= 0) ws.waiters.splice(i, 1)[0].resolve(m);
			else ws.inbox.push(m);
		});
		ws.closed = new Promise((r) => ws.on("close", (code) => r(code)));
		ws.once("open", () => resolve(ws));
		ws.once("unexpected-response", (req, res) => reject(new Error("HTTP " + res.statusCode)));
		ws.once("error", reject);
	});
}
function next(ws, pred = () => true, timeout = 5000) {
	const i = ws.inbox.findIndex(pred);
	if (i >= 0) return Promise.resolve(ws.inbox.splice(i, 1)[0]);
	return new Promise((resolve, reject) => {
		const w = { pred, resolve };
		ws.waiters.push(w);
		setTimeout(() => {
			const j = ws.waiters.indexOf(w);
			if (j >= 0) {
				ws.waiters.splice(j, 1);
				reject(new Error("timeout waiting for message"));
			}
		}, timeout);
	});
}
const type = (t) => (m) => m && m.type === t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟 Agent：两块 GPU，GPU1 空闲显存更多 */
async function fakeAgent(id, gpus) {
	const ws = await wsClient(`ws://127.0.0.1:${ADMIN}/agent?token=${agentToken}&id=${id}`, "ps-agent");
	ws.send(JSON.stringify({ type: "hello", machineId: id, hostname: id, platform: "test", version: "t", cpus: 8, memTotalMB: 32000, gpus }));
	return ws;
}
/** 模拟 UE：按调度器下发的 -PixelStreamingURL 连接 */
async function fakeUe(url) {
	const ws = await wsClient(url);
	await next(ws, type("config"));
	return ws;
}
const urlOf = (startMsg) => startMsg.args.find((a) => a.startsWith("-PixelStreamingURL=")).split("=")[1];
const player = (p, headers) => wsClient(`ws://127.0.0.1:${PUB}${p}`, "peer-stream", headers);

/* -------------------------------------------------------------------- setup */
test.before(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psp-it-"));
	const config = loadConfig({
		baseDir: dir,
		env: {},
		overrides: { http: { port: ADMIN, publicPort: PUB, host: "127.0.0.1" }, localAgent: { enable: false }, log: { level: "warn" } },
	});
	app = createApp({ config, assetsDir: ROOT, selfCommand: [process.execPath, path.join(ROOT, "server.js")], log: createLogger({ level: "error", console: false }), env: {} });
	await app.start();
	agentToken = app.secrets.agentToken;
	const initial = fs.readFileSync(path.join(dir, "data", "initial-admin.txt"), "utf8");
	const pw = initial.match(/初始口令: (\S+)/)[1];
	const r = await api("POST", "/api/v1/auth/login", { username: "admin", password: pw }, { auth: false });
	assert.strictEqual(r.status, 200);
	assert.strictEqual(r.body.mustChangePassword, true);
	cookie = r.headers["set-cookie"][0].split(";")[0];
	assert.strictEqual((await api("POST", "/api/v1/auth/password", { oldPassword: pw, newPassword: "NewPass123" })).status, 200);
});
test.after(async () => app && (await app.stop()));

/* -------------------------------------------------------------------- tests */
test("auth: me, wrong password, CSRF header, role checks", async () => {
	assert.strictEqual((await api("GET", "/api/v1/auth/me")).body.user.username, "admin");
	assert.strictEqual((await api("GET", "/api/v1/auth/me", undefined, { auth: false })).status, 401);
	assert.strictEqual((await api("POST", "/api/v1/auth/login", { username: "admin", password: "bad" }, { auth: false })).status, 401);
	assert.strictEqual((await api("POST", "/api/v1/programs", { id: "x" }, { headers: { "X-PS-Request": "" } })).status, 403, "missing CSRF header");

	assert.strictEqual((await api("POST", "/api/v1/users", { username: "op", password: "Operator1", role: "operator" })).status, 201);
	assert.strictEqual((await api("POST", "/api/v1/users", { username: "vw", password: "Viewer123", role: "viewer" })).status, 201);
	assert.strictEqual((await api("POST", "/api/v1/users", { username: "weak", password: "123", role: "viewer" })).status, 400);
	const saved = cookie;
	const login = async (u, p) => (await api("POST", "/api/v1/auth/login", { username: u, password: p }, { auth: false })).headers["set-cookie"][0].split(";")[0];
	cookie = await login("vw", "Viewer123");
	assert.strictEqual((await api("GET", "/api/v1/programs")).status, 200, "viewer can read");
	assert.strictEqual((await api("POST", "/api/v1/programs", { id: "nope" })).status, 403, "viewer cannot write");
	cookie = await login("op", "Operator1");
	assert.strictEqual((await api("GET", "/api/v1/users")).status, 403, "operator cannot manage users");
	assert.strictEqual((await api("GET", "/api/v1/settings")).status, 403);
	cookie = saved;
	const admins = (await api("GET", "/api/v1/users")).body.filter((u) => u.role === "admin");
	assert.strictEqual((await api("PUT", `/api/v1/users/${admins[0].id}`, { role: "viewer" })).status, 409, "last admin protected");
});

test("security boundaries: public port, proxied requests, agent token", async () => {
	assert.strictEqual((await request(PUB, "GET", "/api/v1/programs")).status, 404, "admin API not on public port");
	assert.strictEqual((await request(PUB, "GET", "/admin/")).status, 404);
	assert.strictEqual((await request(PUB, "GET", "/api/v1/public/programs")).status, 200);
	assert.strictEqual((await request(PUB, "GET", "/healthz")).body.status, "ok");
	assert.strictEqual((await api("GET", "/api/v1/programs", undefined, { headers: { "X-Forwarded-For": "203.0.113.5" } })).status, 403, "proxied = external");
	assert.strictEqual((await api("GET", "/metrics", undefined, { headers: { "X-Forwarded-For": "203.0.113.5" } })).status, 403);
	await assert.rejects(wsClient(`ws://127.0.0.1:${PUB}/ue/default/x`), /403/, "UE not allowed on public port");
	await assert.rejects(wsClient(`ws://127.0.0.1:${ADMIN}/agent?token=wrong&id=x`, "ps-agent"), /401/);
	await assert.rejects(wsClient(`ws://127.0.0.1:${ADMIN}/api/v1/events`), /401/, "events need login");
	const ev = await wsClient(`ws://127.0.0.1:${ADMIN}/api/v1/events`, undefined, { Cookie: cookie });
	assert.strictEqual((await next(ev, type("overview"))).type, "overview");
	ev.close();
});

test("scheduling: placement by free GPU memory, exclusive mode, queue, reuse, UE crash re-queue", async () => {
	const agent = await fakeAgent("render-01", [
		{ index: 0, name: "A", memTotalMB: 8000, memUsedMB: 6000, util: 50 },
		{ index: 1, name: "B", memTotalMB: 8000, memUsedMB: 1000, util: 5 },
	]);
	await sleep(100);
	const machines = (await api("GET", "/api/v1/machines")).body;
	assert.ok(machines.find((m) => m.id === "render-01" && m.online && m.gpus.length === 2));

	const r = await api("POST", "/api/v1/programs", { id: "demo", name: "演示", exe: "C:\\UE\\demo.exe", args: "-Foo=1", mode: "exclusive", max_instances: 2, gpu_mem_mb: 1500, idle_release_sec: 600 });
	assert.strictEqual(r.status, 201, JSON.stringify(r.body));

	// 观众1 → 排队 → 平台下发启动到空闲显存最多的 GPU1
	const p1 = await player("/play/demo", { "X-Forwarded-For": "198.51.100.7", Host: "stream.example.com", "X-Forwarded-Proto": "https" });
	const ice = await next(p1, type("seticeServers"));
	assert.strictEqual(ice.qos, 5000);
	assert.strictEqual((await next(p1, type("playerqueue"))).seq, 1);
	const s1 = await next(agent, type("start"));
	assert.strictEqual(s1.exe, "C:\\UE\\demo.exe");
	assert.ok(s1.args.includes("-graphicsadapter=1"), s1.args.join(" "));
	assert.ok(s1.args.includes("-Foo=1") && s1.args.includes("-ResX=1920") && s1.args.includes("-RenderOffScreen"));
	assert.match(urlOf(s1), new RegExp(`^ws://127\\.0\\.0\\.1:${ADMIN}/ue/demo/${s1.instanceId}$`));
	agent.send(JSON.stringify({ type: "started", instanceId: s1.instanceId, pid: 1234 }));

	const ue1 = await fakeUe(urlOf(s1));
	const pc1 = await next(ue1, type("playerConnected"), 4000); // 像素流1：约 1.5s 后就绪并分配
	ue1.send(JSON.stringify({ type: "offer", playerId: pc1.playerId, sdp: "v=0" }));
	const offer = await next(p1, type("offer"));
	assert.strictEqual(offer.playerId, undefined);
	p1.send(JSON.stringify({ type: "answer", sdp: "v=0" }));
	assert.strictEqual((await next(ue1, type("answer"))).playerId, pc1.playerId);
	p1.send(JSON.stringify({ type: "stats", kbps: 6000, fps: 30, rtt: 25, transport: "relay/tcp→host" }));

	// 观众2 → 第二个实例；预留的 1500MB 让 GPU1 剩 5500 > GPU0 的 2000 → 仍选 GPU1
	const p2 = await player("/play/demo");
	await next(p2, type("seticeServers"));
	const s2 = await next(agent, type("start"));
	assert.notStrictEqual(s2.instanceId, s1.instanceId);
	assert.ok(s2.args.includes("-graphicsadapter=1"));
	const ue2 = await fakeUe(urlOf(s2));
	await next(ue2, type("playerConnected"), 4000);

	// 观众3 → 达到 max_instances=2 → 排队，不再启动
	const p3 = await player("/play/demo");
	assert.strictEqual((await next(p3, type("playerqueue"))).seq, 1);
	await sleep(300);
	assert.ok(!agent.inbox.some(type("start")), "no third instance");
	const live = (await api("GET", "/api/v1/sessions/live")).body;
	assert.strictEqual(live.filter((x) => x.state === "playing").length, 2);
	assert.strictEqual(live.find((x) => x.state === "queued").queuePos, 1);
	assert.strictEqual(live.find((x) => x.ip === "198.51.100.7").external, true);

	// 观众1 离开 → 实例1 复用给观众3（不启动新实例）
	p1.close();
	const pc3 = await next(ue1, type("playerConnected"), 4000);
	assert.ok(pc3.playerId);
	assert.strictEqual((await next(ue1, type("playerDisconnected"))).playerId, pc1.playerId);

	// UE2 崩溃 → 观众2 收到 ueDisConnected → 重新排队 → 平台补启动实例
	ue2.close();
	await next(p2, type("ueDisConnected"));
	const s3 = await next(agent, type("start"), 4000);
	assert.ok(s3.instanceId);
	const stopOld = await next(agent, (m) => m.type === "stop" && m.instanceId === s2.instanceId, 4000);
	assert.ok(stopOld);

	// 会话历史：观众1 的平均码率被记录
	await sleep(100);
	const hist = (await api("GET", "/api/v1/sessions/history?program=demo")).body;
	const done = hist.rows.find((x) => x.ended_at && x.avg_kbps === 6000);
	assert.ok(done, JSON.stringify(hist.rows));
	assert.strictEqual(done.transport, "relay/tcp→host");

	// 管理员停止实例1：其观众重新排队；Agent 收到 stop
	assert.strictEqual((await api("POST", `/api/v1/instances/${s1.instanceId}/stop`)).status, 200);
	await next(agent, (m) => m.type === "stop" && m.instanceId === s1.instanceId);
	await next(p3, type("ueDisConnected"));

	for (const ws of [p2, p3, ue1, agent]) ws.close();
	await sleep(200);
});

test("startup timeout and process error: failed instance retried on another GPU", async () => {
	const agent = await fakeAgent("render-02", [
		{ index: 0, memTotalMB: 16000, memUsedMB: 0, util: 0 },
		{ index: 1, memTotalMB: 16000, memUsedMB: 4000, util: 0 },
	]);
	await sleep(100);
	await api("POST", "/api/v1/programs", { id: "slow", exe: "C:\\UE\\slow.exe", mode: "exclusive", max_instances: 3, machines: ["render-02"], startup_timeout_sec: 10 });
	const p = await player("/play/slow");
	const s1 = await next(agent, type("start"));
	assert.ok(s1.args.includes("-graphicsadapter=0"));
	// 进程立即报错（例如路径不存在）→ 判失败 → 换 GPU1 重试
	agent.send(JSON.stringify({ type: "error", instanceId: s1.instanceId, message: "可执行文件不存在" }));
	const s2 = await next(agent, (m) => m.type === "start" && m.instanceId !== s1.instanceId);
	assert.ok(s2.args.includes("-graphicsadapter=1"), "bad slot avoided");
	const prog = (await api("GET", "/api/v1/programs")).body.find((x) => x.id === "slow");
	assert.match(prog.runtime.lastError || "", /可执行文件不存在/);
	// 第二次 UE 一直不连 → 10 秒超时 → Agent 收到 stop
	const stop = await next(agent, (m) => m.type === "stop" && m.instanceId === s2.instanceId, 15000);
	assert.ok(stop);
	// 两块 GPU 都在失败退避期（2 分钟）内：不再盲目重启，观众保持排队，并显示失败原因
	await sleep(2500);
	assert.ok(!agent.inbox.some((m) => m.type === "start"), "no hammering while every slot is backing off");
	const prog2 = (await api("GET", "/api/v1/programs")).body.find((x) => x.id === "slow");
	assert.match(prog2.runtime.lastError || "", /未连接平台|没有可用/);
	assert.strictEqual(prog2.runtime.queue, 1);
	p.close();
	agent.close();
	await api("DELETE", "/api/v1/programs/slow");
});

test("share links: token required, valid token works, revoked token rejected", async () => {
	await api("POST", "/api/v1/programs", { id: "secret", name: "受保护", require_token: true, mode: "shared", max_viewers: 5 });
	const noTok = await player("/play/secret");
	assert.match(await next(noTok, (m) => typeof m === "string"), /访问链接/);
	assert.strictEqual(await noTok.closed, 4003);

	const link = (await api("POST", "/api/v1/share-links", { programId: "secret", hours: 1, maxUses: 5, note: "客户演示" })).body;
	assert.match(link.path, /^\/play\/secret\?token=/);
	const ok = await player(link.path);
	assert.strictEqual((await next(ok, type("seticeServers"))).type, "seticeServers");
	ok.close();
	assert.strictEqual((await api("GET", "/api/v1/share-links")).body.find((l) => l.id === link.id).uses, 1);

	await api("POST", `/api/v1/share-links/${link.id}/revoke`);
	const revoked = await player(link.path);
	assert.match(await next(revoked, (m) => typeof m === "string"), /失效/);
	const pub = (await request(PUB, "GET", "/api/v1/public/programs")).body;
	assert.ok(pub.find((x) => x.id === "secret").requireToken);
});

test("legacy UE (no instance id) joins the default program as a manual instance", async () => {
	const ue = await fakeUe(`ws://127.0.0.1:${ADMIN}/`);
	const p = await player("/");
	const pc = await next(ue, type("playerConnected"), 4000);
	ue.send(JSON.stringify({ type: "offer", playerId: pc.playerId, sdp: "v=0" }));
	await next(p, type("offer"));
	const inst = (await api("GET", "/api/v1/instances")).body.find((i) => i.programId === "default");
	assert.strictEqual(inst.managed, false);
	assert.strictEqual(inst.state, "busy");
	// PS2：发 endpointId 立即就绪
	const ue2 = await fakeUe(`ws://127.0.0.1:${ADMIN}/default`);
	ue2.send(JSON.stringify({ type: "endpointId", id: "ps2" }));
	assert.strictEqual((await next(ue2, type("endpointIdConfirm"))).committedId, "ps2");
	p.close();
	ue.close();
	ue2.close();
});

test("overview, metrics, settings validation, audit, unknown program", async () => {
	const o = (await api("GET", "/api/v1/overview")).body;
	assert.ok(o.kpis && Array.isArray(o.programs) && Array.isArray(o.machines));
	const m = await api("GET", "/metrics");
	assert.match(m.text, /psp_viewers \d+/);
	assert.match(m.text, /psp_program_viewers\{program="demo"\}/);
	assert.strictEqual((await api("PUT", "/api/v1/settings", { turn: { forceRelay: "maybe" } })).status, 400);
	const s = await api("PUT", "/api/v1/settings", { turn: { forceRelay: "external", servers: [{ id: "dc", urls: ["turn:dc.example.com:3478"], secret: "dcsecret", scope: "all" }] } });
	assert.strictEqual(s.status, 200);
	assert.strictEqual(s.body.turn.servers[0].secret, "******", "secrets masked");
	const p = await player("/play/demo", { "X-Forwarded-For": "203.0.113.9" });
	const ice = await next(p, type("seticeServers"));
	assert.strictEqual(ice.iceTransportPolicy, "relay", "external viewer forced to relay");
	assert.match(ice.iceServers[0].username, /^\d+:p\d+$/);
	p.close();
	const audit = (await api("GET", "/api/v1/audit")).body;
	assert.ok(audit.some((a) => a.action === "program.create") && audit.some((a) => a.action === "auth.login_failed"));
	const bad = await player("/play/nope");
	assert.match(await next(bad, (x) => typeof x === "string"), /未找到/);
});
