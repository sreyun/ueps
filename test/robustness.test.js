"use strict";
// 稳定性 / 安全加固回归测试：实例接管与对账、僵尸 UE 重连、Agent 进程表、白名单边界、设置脱敏、输入校验、登录防爆破等
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { startPlatform, wsClient, next, type, sleep } = require("./helpers.js");
const { createAgent, pidAlive } = require("../agent/agent.js");
const { Settings } = require("../src/settings.js");
const { Store, normalizeProgram } = require("../src/store.js");
const { loadConfig } = require("../src/config.js");

async function rawAgent(ctx, id, procs = []) {
	const ws = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/agent?token=${ctx.app.secrets.agentToken}&id=${id}`, "ps-agent");
	ws.send(JSON.stringify({ type: "hello", machineId: id, hostname: id, platform: "test", version: "t", cpus: 8, memTotalMB: 32000, gpus: [], procs }));
	ws.stats = (list) => ws.send(JSON.stringify({ type: "stats", cpu: 1, memUsedMB: 1, gpus: [], procs: list }));
	await sleep(120);
	return ws;
}

test("reconcile: adopt running UE after platform restart, clean up orphans, manual→managed, reject zombie reconnects", async () => {
	const ctx = await startPlatform();
	try {
		await ctx.login();
		assert.strictEqual((await ctx.api("POST", "/api/v1/programs", { id: "p1", exe: "C:\\fake\\ue.exe", ue_version: "4.27", prewarm: 1, max_instances: 3 })).status, 201);
		// Agent 带着两个仍在运行的进程上线：p1 的实例被接管；未知程序的进程被清理
		const ag = await rawAgent(ctx, "r1", [
			{ instanceId: "keep000001", programId: "p1", pid: 4242, gpu: 0 },
			{ instanceId: "orphan0001", programId: "gone", pid: 4343, gpu: 0 },
		]);
		const stop = await next(ag, (m) => m.type === "stop" && m.instanceId === "orphan0001");
		assert.ok(stop);
		const inst = ctx.app.scheduler.instances.get("keep000001");
		assert.ok(inst && inst.managed && inst.adopted && inst.machineId === "r1" && inst.state === "starting");
		// 已有接管实例满足预热数，不应再拉起新实例
		await sleep(300);
		assert.ok(!ag.inbox.some((m) => m.type === "start"), "should not launch a duplicate prewarm instance");
		// UE 重连 → 绑定到接管的实例并就绪
		const ue = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/ue/p1/keep000001`);
		await next(ue, type("config"));
		await sleep(100);
		assert.strictEqual(inst.ue !== null && inst.ueReady, true);
		assert.strictEqual(inst.state, "idle");

		// UE 先于 Agent 连上：先作为手动实例，Agent 上报后转为受管
		const ue2 = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/ue/p1/early00001`);
		await next(ue2, type("config"));
		const manual = ctx.app.scheduler.instances.get("early00001");
		assert.strictEqual(manual.managed, false);
		ag.stats([
			{ instanceId: "keep000001", programId: "p1", pid: 4242, gpu: 0 },
			{ instanceId: "early00001", programId: "p1", pid: 4444, gpu: 0 },
		]);
		await sleep(150);
		assert.strictEqual(manual.managed, true);
		assert.strictEqual(manual.machineId, "r1");
		assert.ok(ctx.app.scheduler.byMachine.get("r1").has(manual));

		// 停止实例后，同一实例 ID 的 UE 重连被拒绝（4009），不会"复活"
		assert.strictEqual((await ctx.api("POST", "/api/v1/instances/keep000001/stop")).status, 200);
		await next(ag, (m) => m.type === "stop" && m.instanceId === "keep000001");
		ag.send(JSON.stringify({ type: "exited", instanceId: "keep000001", code: 0 }));
		await ue.closed;
		await sleep(100);
		assert.ok(!ctx.app.scheduler.instances.has("keep000001"));
		const zombie = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/ue/p1/keep000001`);
		assert.strictEqual(await zombie.closed, 4009);
		// Agent 再次上报该进程（例如 Agent 断线期间没收到停止命令）→ 再次下发停止
		ag.stats([{ instanceId: "keep000001", programId: "p1", pid: 4242, gpu: 0 }]);
		assert.ok(await next(ag, (m) => m.type === "stop" && m.instanceId === "keep000001"));

		// 受管实例的进程在 Agent 断线期间消失 → 对账时按退出处理
		const early = ctx.app.scheduler.instances.get("early00001");
		ue2.close();
		await sleep(150);
		assert.ok(!ctx.app.scheduler.instances.has(early.id));
		ag.stats([{ instanceId: "vanish0001", programId: "p1", pid: 5555, gpu: 0 }]);
		await sleep(100);
		assert.ok(ctx.app.scheduler.instances.get("vanish0001")?.adopted);
		ag.stats([]); // 进程已不在（且 UE 未连接）→ 移除，不留僵尸记录
		await sleep(100);
		assert.ok(!ctx.app.scheduler.instances.has("vanish0001"));
		ag.close();
	} finally {
		await ctx.stop();
	}
});

test("agent: allow-exe directory boundary, state file adoption across restarts, killAll", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psa-"));
	fs.mkdirSync(path.join(dir, "ue"));
	fs.mkdirSync(path.join(dir, "ue-evil"));
	fs.writeFileSync(path.join(dir, "ue-evil", "x.exe"), "");
	const msgs = [];
	const a1 = createAgent({ send: (m) => msgs.push(m), machineId: "t", allowExe: [path.join(dir, "ue")], log: {}, gpuProvider: async () => [] });
	a1.handle({ type: "start", instanceId: "i1", exe: path.join(dir, "ue-evil", "x.exe"), args: [] });
	assert.match(msgs.find((m) => m.type === "error").message, /白名单/);
	a1.handle({ type: "start", instanceId: "i2", exe: path.join(dir, "ue"), args: ["--x", 1] }); // 非字符串参数直接忽略
	assert.strictEqual(msgs.filter((m) => m.instanceId === "i2").length, 0);
	a1.close();

	// 进程表持久化：新 Agent 实例（模拟 Agent/平台崩溃后重启）接管仍在运行的进程
	const stateFile = path.join(dir, "state.json");
	const out = [];
	const a2 = createAgent({ send: (m) => out.push(m), machineId: "t", stateFile, log: {}, gpuProvider: async () => [] });
	a2.handle({ type: "start", instanceId: "live1", programId: "p1", gpu: 0, exe: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
	const started = out.find((m) => m.type === "started");
	assert.ok(started && started.pid);
	a2.close(); // 不 killAll：模拟崩溃
	const out3 = [];
	const a3 = createAgent({ send: (m) => out3.push(m), machineId: "t", stateFile, log: {}, gpuProvider: async () => [] });
	await a3.hello();
	await sleep(20);
	const hello = out3.find((m) => m.type === "hello");
	const p = hello.procs.find((x) => x.instanceId === "live1");
	assert.ok(p, "adopted process reported in hello");
	assert.strictEqual(p.pid, started.pid);
	assert.strictEqual(p.programId, "p1");
	a3.killAll();
	for (let i = 0; i < 50 && pidAlive(started.pid); i++) await sleep(100);
	assert.strictEqual(pidAlive(started.pid), false, "killAll terminates adopted process");
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), []);
	a3.close();
	// 状态文件里的 PID 已不存在 / 映像名不符 → 不接管
	fs.writeFileSync(stateFile, JSON.stringify([{ instanceId: "dead", pid: started.pid, exe: process.execPath }, { instanceId: "other", pid: process.pid, exe: "C:\\x\\notnode.exe" }]));
	const out4 = [];
	const a4 = createAgent({ send: (m) => out4.push(m), machineId: "t", stateFile, log: {}, gpuProvider: async () => [] });
	await a4.hello();
	assert.deepStrictEqual(out4.find((m) => m.type === "hello").procs, []);
	a4.close();
});

test("settings: masked secrets survive reordering and are matched by id; ICE credentials masked", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pss-"));
	const store = new Store(dir);
	try {
		const config = loadConfig({ baseDir: dir, env: {} });
		const s = new Settings(store, { turn: "builtin-secret" }, config);
		s.update({ turn: { servers: [{ id: "a", urls: ["turn:a:3478"], secret: "sa" }, { id: "b", urls: ["turn:b:3478"], secret: "sb" }] }, iceServers: [{ urls: "turn:x:3478", username: "u", credential: "cx" }] });
		const v = s.view();
		assert.strictEqual(v.turn.servers[0].secret, "******");
		assert.strictEqual(v.iceServers[0].credential, "******");
		// 管理端回传脱敏后的列表，且调换顺序
		s.update({ turn: { servers: [v.turn.servers[1], v.turn.servers[0]] }, iceServers: v.iceServers });
		const g = s.get();
		assert.deepStrictEqual(g.turn.servers.map((x) => [x.id, x.secret]), [["b", "sb"], ["a", "sa"]]);
		assert.strictEqual(g.iceServers[0].credential, "cx");
		assert.throws(() => s.update({ iceServers: [{ urls: "http://bad" }] }), /iceServers/);
		assert.strictEqual(s.get().iceServers[0].credential, "cx", "failed update leaves settings unchanged");
	} finally {
		store.close();
	}
});

test("UE console commands are opt-in per program", () => {
	const { buildArgs } = require("../src/scheduler.js");
	assert.ok(!buildArgs(normalizeProgram({ id: "a" }), "ws://x/ue/a/1", 0).includes("-AllowPixelStreamingCommands"));
	assert.ok(buildArgs(normalizeProgram({ id: "a", allow_commands: true }), "ws://x/ue/a/1", 0).includes("-AllowPixelStreamingCommands"));
});

test("store: program field whitelist and types, query limits clamped", () => {
	const p = normalizeProgram({ id: "ok", exe: "a.exe", evil: 1, runtime: { x: 1 } });
	assert.ok(!("evil" in p) && !("runtime" in p));
	assert.throws(() => normalizeProgram({ id: "ok", exe: { cmd: "x" } }), /exe 必须是字符串/);
	assert.throws(() => normalizeProgram({ id: "ok", name: "x".repeat(65) }), /name/);
	assert.throws(() => normalizeProgram({ id: "ok", machines: [1] }), /machines/);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pss-"));
	const store = new Store(dir);
	try {
		for (let i = 0; i < 30; i++) store.audit({ action: "x" + i });
		assert.strictEqual(store.listAudit({ limit: -1 }).length, 1);
		assert.strictEqual(store.listAudit({ limit: "abc" }).length, 30);
		assert.strictEqual(store.querySessions({ limit: -5 }).rows.length, 0);
		assert.throws(() => store.transaction(() => (store.audit({ action: "in-tx" }), assert.fail("boom"))));
		assert.ok(!store.listAudit({ limit: 500 }).some((a) => a.action === "in-tx"), "transaction rolled back");
	} finally {
		store.close();
	}
});

test("security: per-username login lockout across IPs, revoked admin cookie cannot bypass share token, message flood, path tricks, atomic restore", async () => {
	const ctx = await startPlatform();
	try {
		// 多个来源 IP 轮换爆破同一账号 → 按用户名锁定
		for (let i = 1; i <= 5; i++) {
			const r = await ctx.api("POST", "/api/v1/auth/login", { username: "admin", password: "wrong-" + i }, { auth: false, headers: { "X-Forwarded-For": `10.9.0.${i}` } });
			assert.strictEqual(r.status, 401);
		}
		const locked = await ctx.api("POST", "/api/v1/auth/login", { username: "admin", password: "Admin12345" }, { auth: false, headers: { "X-Forwarded-For": "10.9.0.99" } });
		assert.strictEqual(locked.status, 429);
		ctx.app.ctx.limiter.map.clear();
		assert.strictEqual((await ctx.login()).status, 200);

		// require_token 程序：管理员会话在管理口可免令牌预览；"退出全部设备"后旧 Cookie 失效
		await ctx.api("POST", "/api/v1/programs", { id: "sec", require_token: true });
		const cookie = ctx.cookie;
		const pv = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/play/sec`, "peer-stream", { Cookie: cookie });
		await next(pv, type("seticeServers"));
		pv.close();
		await ctx.api("POST", "/api/v1/auth/logout-all");
		const pv2 = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/play/sec`, "peer-stream", { Cookie: cookie });
		assert.strictEqual(await pv2.closed, 4003);
		await ctx.login();

		// 限次分享链接：同一观众刷新/重连不重复计数，其他来源用完即止
		const link = (await ctx.api("POST", "/api/v1/share-links", { programId: "sec", maxUses: 1 })).body;
		for (let i = 0; i < 2; i++) {
			const v = await ctx.player(link.path, { "X-Forwarded-For": "203.0.113.7" });
			await next(v, type("seticeServers"));
			v.close();
		}
		const other = await ctx.player(link.path, { "X-Forwarded-For": "203.0.113.8" });
		assert.strictEqual(await other.closed, 4003);

		// 观众信令洪泛 → 断开（1008）
		const flood = await ctx.player("/play/default");
		await next(flood, type("seticeServers"));
		for (let i = 0; i < 1200; i++) flood.send('{"type":"iceCandidate","candidate":{}}');
		assert.strictEqual(await flood.closed, 1008);

		// 路径技巧：编码穿越 / NUL / 非法编码 / 隐藏文件
		for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/player.html%00.txt", "/%E0%A4%A", "/.git/config", "/api/v1/programs/%E0%A4%A"]) {
			const r = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: ctx.PUB, path: p }, (res) => (res.resume(), resolve(res.statusCode))));
			assert.ok([400, 403, 404].includes(r), `${p} → ${r}`);
		}

		// 恢复备份是原子的：任一条目非法则全部不生效
		const bad = await ctx.api("POST", "/api/v1/restore", { kind: "ps-platform-backup", programs: [{ id: "good-one" }, { id: "BAD ID" }] });
		assert.strictEqual(bad.status, 400);
		assert.strictEqual((await ctx.api("GET", "/api/v1/programs/good-one")).status, 404);
	} finally {
		await ctx.stop();
	}
});

test("heartbeat: agents and UE that answer pings stay connected across heartbeats; dead peers are dropped", async () => {
	const ctx = await startPlatform();
	try {
		const ag = await rawAgent(ctx, "hb1");
		const ue = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/ue/default`);
		await next(ue, type("config"));
		const player = await ctx.player("/play/default");
		await next(player, type("seticeServers"));
		for (let i = 0; i < 3; i++) {
			ctx.app.signaling.beat();
			await sleep(150);
		}
		assert.strictEqual(ag.readyState, 1, "agent survives heartbeats");
		assert.strictEqual(ue.readyState, 1, "UE survives heartbeats");
		assert.strictEqual(player.readyState, 1, "player survives heartbeats");
		assert.ok(ctx.app.agents.get("hb1")?.ready);
		// 不回 pong 的对端（例如网络断开）在两次心跳后被清理
		ag.pong = () => {};
		ag._receiver?.removeAllListeners?.("ping");
		ag._socket.pause(); // 模拟失联：不再读取任何数据
		ctx.app.signaling.beat();
		await sleep(100);
		ctx.app.signaling.beat();
		await sleep(300);
		assert.ok(!ctx.app.agents.get("hb1"), "silent agent removed");
		ue.close();
		player.close();
	} finally {
		await ctx.stop();
	}
});

test("rate limit applies to viewers only: many UEs from one render machine still connect", async () => {
	const ctx = await startPlatform();
	try {
		await ctx.login();
		await ctx.api("PUT", "/api/v1/settings", { security: { rateLimit: { wsPerSec: 1, wsBurst: 1 } } });
		const ues = await Promise.all([...Array(6)].map(() => wsClient(`ws://127.0.0.1:${ctx.ADMIN}/ue/default`)));
		for (const ue of ues) await next(ue, type("config"));
		const results = await Promise.allSettled([...Array(4)].map(() => ctx.player("/play/default")));
		assert.ok(results.some((r) => r.status === "rejected" && /429/.test(r.reason.message)), "viewer flood throttled");
		for (const r of results) if (r.status === "fulfilled") r.value.close();
		for (const ue of ues) ue.close();
	} finally {
		await ctx.stop();
	}
});

test("TURN port also serves plain HTTP: HTTP requests are handed off with the real client IP, STUN still works", async () => {
	const net = require("net");
	const { TurnServer } = require("../lib/turn-tcp.js");
	let captured = "";
	const cap = net.createServer((s) => {
		s.on("data", (d) => {
			captured += d.toString("latin1");
			if (captured.includes("\r\n\r\n")) s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
		});
	});
	await new Promise((r) => cap.listen(0, "127.0.0.1", r));
	const silent = { info() {}, warn() {}, error() {}, debug() {} };
	const turn = new TurnServer({ listen: ["127.0.0.1:0"], relayIp: "127.0.0.1", minPort: 0, maxPort: 0, secret: "s", log: silent, httpFallback: `127.0.0.1:${cap.address().port}` });
	await turn.start();
	const port = turn.servers[0].address().port;
	try {
		// 模拟 nginx：PROXY 头与 HTTP 请求分片到达（方法名也被拆开）
		const reply = await new Promise((resolve, reject) => {
			const c = net.connect(port, "127.0.0.1", async () => {
				c.write("PROXY TCP4 203.0.113.9 127.0.0.1 5555 ");
				await sleep(30);
				c.write("443\r\nGE");
				await sleep(30);
				c.write("T /video.html?urlPrefix=JJQ HTTP/1.1\r\nHost: 1.2.3.4:6443\r\n\r\n");
			});
			let out = "";
			c.on("data", (d) => (out += d));
			c.on("end", () => resolve(out));
			c.on("error", reject);
		});
		assert.match(reply, /^HTTP\/1\.1 200 OK/);
		assert.match(captured, /^PROXY TCP4 203\.0\.113\.9 127\.0\.0\.1 5555 \d+\r\nGET \/video\.html\?urlPrefix=JJQ HTTP\/1\.1\r\n/);
		// STUN Binding 请求仍按 TURN 处理
		const stun = await new Promise((resolve, reject) => {
			const c = net.connect(port, "127.0.0.1", () => {
				const req = Buffer.alloc(20);
				req.writeUInt16BE(0x0001, 0);
				req.writeUInt16BE(0, 2);
				req.writeUInt32BE(0x2112a442, 4);
				require("crypto").randomBytes(12).copy(req, 8);
				c.write(req);
			});
			c.once("data", (d) => (c.destroy(), resolve(d)));
			c.on("error", reject);
		});
		assert.strictEqual(stun.readUInt16BE(0), 0x0101, "binding success response");
	} finally {
		await turn.stop?.();
		cap.close();
	}
});

test("behind an upstream reverse proxy (router/CDN): real viewer IP from the X-Forwarded-For chain only when that proxy is trusted", async () => {
	for (const [trust, expectIp, expectExternal] of [
		[["127.0.0.1", "::1", "192.168.10.1"], "203.0.113.5", true],
		[["127.0.0.1", "::1"], "192.168.10.1", false],
	]) {
		const ctx = await startPlatform({ security: { trustProxy: trust } });
		try {
			// nginx 追加了它看到的来源（路由器 192.168.10.1）；路由器之前追加了真实观众 IP；最左侧是客户端伪造的值
			const p = await ctx.player("/play/default", { "X-Forwarded-For": "6.6.6.6, 203.0.113.5, 192.168.10.1" });
			await next(p, type("seticeServers"));
			const live = [...ctx.app.signaling.players.values()][0];
			assert.strictEqual(live.ip, expectIp);
			assert.strictEqual(live.external, expectExternal);
			p.close();
		} finally {
			await ctx.stop();
		}
	}
});

test("agent disconnect while an instance is starting does not put the GPU slot into failure backoff", async () => {
	const ctx = await startPlatform();
	try {
		await ctx.login();
		await ctx.api("POST", "/api/v1/programs", { id: "bo", exe: "C:\\fake\\ue.exe", ue_version: "4.27", prewarm: 1, max_instances: 2 });
		const a1 = await rawAgent(ctx, "solo");
		const start1 = await next(a1, type("start"));
		a1.close(); // Agent 在实例启动途中断线
		await sleep(200);
		const rt = ctx.app.scheduler.programs.get("bo");
		assert.strictEqual(rt.badSlots.size, 0, "no backoff for agent-offline failures");
		const a2 = await rawAgent(ctx, "solo"); // 重连后应立即重新拉起预热实例
		const start2 = await next(a2, type("start"), 3000);
		assert.notStrictEqual(start2.instanceId, start1.instanceId);
		a2.close();
	} finally {
		await ctx.stop();
	}
});
