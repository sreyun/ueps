"use strict";
/**
 * 平台并发压测（信令 + 调度）：A 个模拟渲染机 Agent，P 个观众同时进入一个独占模式程序（一人一实例），
 * Agent 收到启动命令后立即以模拟 UE 连回平台。测量：观众连接 → 收到 UE offer 的端到端耗时；全部离开后的缩容时间。
 *
 *   node test/load/platform-load.js --admin http://127.0.0.1:19088 --public ws://127.0.0.1:19089 \
 *        --user admin --password xxx --agents 20 --players 300 --rate 50
 */
const http = require("http");
const WebSocket = require("ws");

const arg = (k, d) => {
	const i = process.argv.indexOf("--" + k);
	return i > 0 ? process.argv[i + 1] : d;
};
const ADMIN = arg("admin", "http://127.0.0.1:88");
const PUBLIC = arg("public", "ws://127.0.0.1:8088");
const AGENTS = +arg("agents", 10);
const PLAYERS = +arg("players", 100);
const RATE = +arg("rate", 50);
const PROGRAM = arg("program", "loadtest");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] : 0);

let cookie = "";
function call(method, path, body) {
	return new Promise((resolve, reject) => {
		const u = new URL(ADMIN + "/api/v1" + path);
		const data = body ? JSON.stringify(body) : null;
		const req = http.request(u, { method, headers: { "Content-Type": "application/json", "X-PS-Request": "1", Cookie: cookie } }, (res) => {
			let s = "";
			res.on("data", (c) => (s += c));
			res.on("end", () => {
				if (res.headers["set-cookie"]) cookie = res.headers["set-cookie"][0].split(";")[0];
				const j = s ? JSON.parse(s) : null;
				res.statusCode < 400 ? resolve(j) : reject(new Error(`${method} ${path} ${res.statusCode} ${j?.error}`));
			});
		});
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
}

const stats = { started: 0, stopped: 0, ueConnected: 0 };

function fakeAgent(i, token) {
	return new Promise((resolve, reject) => {
		const id = `load-agent-${i}`;
		const ws = new WebSocket(`${ADMIN.replace(/^http/, "ws")}/agent?token=${token}&id=${id}`, "ps-agent", { perMessageDeflate: false });
		const ues = new Map();
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "hello", machineId: id, hostname: id, platform: "load", version: "load", cpus: 32, memTotalMB: 65536, gpus: [{ index: 0, memTotalMB: 24000, memUsedMB: 0, util: 0 }, { index: 1, memTotalMB: 24000, memUsedMB: 0, util: 0 }] }));
			resolve({ id, ws, ues });
		});
		ws.on("error", reject);
		ws.on("message", (raw) => {
			const m = JSON.parse(raw);
			if (m.type === "start") {
				stats.started++;
				ws.send(JSON.stringify({ type: "started", instanceId: m.instanceId, pid: 10000 + stats.started }));
				const url = m.args.find((a) => a.startsWith("-PixelStreamingURL=")).split("=")[1];
				const ue = new WebSocket(url, { perMessageDeflate: false });
				ues.set(m.instanceId, ue);
				ue.on("open", () => {
					stats.ueConnected++;
					ue.send(JSON.stringify({ type: "endpointId", id: m.instanceId })); // 像素流2：立即就绪
				});
				ue.on("message", (r) => {
					const x = JSON.parse(r);
					if (x.type === "playerConnected") ue.send(JSON.stringify({ type: "offer", playerId: x.playerId, sdp: "v=0" }));
				});
				ue.on("error", () => {});
			} else if (m.type === "stop") {
				stats.stopped++;
				ues.get(m.instanceId)?.close();
				ues.delete(m.instanceId);
				ws.send(JSON.stringify({ type: "exited", instanceId: m.instanceId, code: 0 }));
			}
		});
	});
}

function player() {
	return new Promise((resolve) => {
		const t0 = performance.now();
		// 经 nginx 单端口多路复用时必须像浏览器一样携带 ALPN，否则会被当作 TURNS 分流；自签名证书时可设 NODE_TLS_REJECT_UNAUTHORIZED=0
		const ws = new WebSocket(`${PUBLIC}/play/${PROGRAM}`, "peer-stream", { perMessageDeflate: false, ALPNProtocols: ["http/1.1"] });
		const p = { ws, ok: false, ms: 0 };
		ws.on("message", (raw) => {
			let m;
			try {
				m = JSON.parse(raw);
			} catch {
				return;
			}
			if (m.type === "offer" && !p.ok) {
				p.ok = true;
				p.ms = performance.now() - t0;
				ws.send(JSON.stringify({ type: "answer", sdp: "v=0" }));
				resolve(p);
			} else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
		});
		ws.on("error", () => resolve(p));
		setTimeout(() => resolve(p), 30000);
	});
}

(async () => {
	await call("POST", "/auth/login", { username: arg("user", "admin"), password: arg("password", "") });
	const token = (await call("GET", "/agent-install")).token;
	// 压测端只有一个来源 IP：测试期间临时关闭观众连接限流，结束后恢复
	const origRl = (await call("GET", "/settings")).security.rateLimit;
	await call("PUT", "/settings", { security: { rateLimit: { ...origRl, wsPerSec: 0 } } });
	await call("DELETE", `/programs/${PROGRAM}`).catch(() => {});
	await call("POST", "/programs", { id: PROGRAM, name: "压测", exe: "C:\\fake\\load.exe", mode: "exclusive", max_instances: PLAYERS + 10, idle_release_sec: 3, startup_timeout_sec: 30, ue_version: "5.52", machines: [...Array(AGENTS)].map((_, i) => `load-agent-${i}`) }); // 只放到模拟渲染机上，不影响真实机器
	const agents = [];
	for (let i = 0; i < AGENTS; i++) agents.push(await fakeAgent(i, token));
	await sleep(500);
	const sys0 = await call("GET", "/system");
	console.log(`agents=${AGENTS} players=${PLAYERS} rate=${RATE}/s  platform rss=${sys0.memoryMB}MB`);

	const t0 = performance.now();
	const pending = [];
	for (let i = 0; i < PLAYERS; i++) {
		pending.push(player());
		if ((i + 1) % RATE === 0) await sleep(1000);
	}
	const players = await Promise.all(pending);
	const rampMs = performance.now() - t0;
	const lat = players.filter((p) => p.ok).map((p) => p.ms).sort((a, b) => a - b);
	const ov = await call("GET", "/overview");
	const sys1 = await call("GET", "/system");
	const perAgent = {};
	for (const i of ov.instances) if (i.programId === PROGRAM) perAgent[i.machineId] = (perAgent[i.machineId] || 0) + 1;
	const spread = Object.values(perAgent);

	// 全部离开 → 等待空闲回收
	const tLeave = performance.now();
	players.forEach((p) => p.ws.close());
	let left = -1;
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		left = (await call("GET", "/instances")).filter((i) => i.programId === PROGRAM).length; // 只统计压测程序（不受其它程序预热实例影响）
		if (left === 0) break;
	}
	const scaleDownMs = performance.now() - tLeave;
	const result = {
		players: PLAYERS,
		gotOffer: lat.length,
		instancesStarted: stats.started,
		ueConnected: stats.ueConnected,
		msToOffer: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), max: Math.round(lat[lat.length - 1] || 0) },
		rampSeconds: +(rampMs / 1000).toFixed(1),
		placement: { agentsUsed: spread.length, minPerAgent: Math.min(...spread), maxPerAgent: Math.max(...spread) },
		platformRssMB: { before: sys0.memoryMB, atPeak: sys1.memoryMB },
		scaleDown: { instancesLeft: left, stopsSent: stats.stopped, seconds: +(scaleDownMs / 1000).toFixed(1) },
	};
	console.log(JSON.stringify(result, null, 2));
	await call("DELETE", `/programs/${PROGRAM}`).catch(() => {});
	agents.forEach((a) => a.ws.close());
	await call("PUT", "/settings", { security: { rateLimit: origRl } }).catch(() => {});
	// 清理模拟渲染机的机器记录（离线后才能删除）
	await sleep(500);
	for (const a of agents) await call("DELETE", `/machines/${a.id}`).catch(() => {});
	process.exit(result.gotOffer === PLAYERS && left === 0 ? 0 : 1);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
