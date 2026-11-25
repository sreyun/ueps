"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { pathfind, coordinateConvert } = require("../src/tools.js");
const sec = require("../src/security.js");
const { buildArgs, inHours } = require("../src/scheduler.js");
const { createLogger } = require("../src/logger.js");

test("tools.pathfind: projects routing points onto roads and follows the shortest path (enterprise format)", () => {
	// 一个"日"字形路网：A(0,0)-B(10,0)-C(20,0)，D(0,10)-E(10,10)-F(20,10)，竖线 A-D、B-E、C-F
	const P = (id, x, y) => ({ id, location: `X=${x},Y=${y},Z=0` });
	const body = {
		roadNet: {
			points: [P("A", 0, 0), P("B", 10, 0), P("C", 20, 0), P("D", 0, 10), P("E", 10, 10), P("F", 20, 10)],
			lines: ["A,B", "B,C", "D,E", "E,F", "A,D", "B,E", "C,F"].map((linkIds) => ({ linkIds })),
		},
		routingPoints: [{ rp_location: "X=1,Y=-2,Z=5" }, { rp_location: "X=19,Y=12,Z=7" }],
	};
	const r = pathfind(body);
	assert.strictEqual(r.status, 0);
	assert.strictEqual(r.ResultPoints[0], "X=1.00,Y=0.00,Z=5.00", "start projected onto A-B");
	assert.strictEqual(r.ResultPoints[r.ResultPoints.length - 1], "X=19.00,Y=10.00,Z=7.00", "end projected onto E-F");
	// 最短：(1,0)→B→E→(19,10) 或 →B→C→F→… 两者长度相同为 9+10+9=28；中间点必须是原始节点坐标字符串
	assert.strictEqual(r.length, 28);
	for (const mid of r.ResultPoints.slice(1, -1)) assert.match(mid, /^X=\d+,Y=\d+,Z=0$/);
	// 同一路段上的两个点：直接相连
	const same = pathfind({ ...body, routingPoints: [{ rp_location: "X=2,Y=1,Z=0" }, { rp_location: "X=8,Y=-1,Z=0" }] });
	assert.deepStrictEqual(same.ResultPoints, ["X=2.00,Y=0.00,Z=0.00", "X=8.00,Y=0.00,Z=0.00"]);
	assert.throws(() => pathfind({ ...body, roadNet: { ...body.roadNet, lines: [{ linkIds: "A,Z" }] } }), /不存在的节点/);
	assert.throws(() => pathfind({ ...body, routingPoints: [{ rp_location: "bad" }, { rp_location: "X=1,Y=1,Z=1" }] }), /坐标格式/);
	// 不连通
	assert.throws(() => pathfind({ roadNet: { points: [P("a", 0, 0), P("b", 1, 0), P("c", 50, 50), P("d", 51, 50)], lines: [{ linkIds: "a,b" }, { linkIds: "c,d" }] }, routingPoints: [{ rp_location: "X=0,Y=0,Z=0" }, { rp_location: "X=51,Y=50,Z=0" }] }), /没有连通/);
});

test("tools.coordinateConvert: similarity transform from two control points", () => {
	// B = A 旋转 90°、放大 2 倍、平移 (100, 50)
	const r = coordinateConvert({ CoordinateA1: { x: 0, y: 0 }, CoordinateA2: { x: 1, y: 0 }, CoordinateB1: { x: 100, y: 50 }, CoordinateB2: { x: 100, y: 52 }, CoordinateA: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 3, y: 4 }] });
	const round = (p) => ({ x: +p.x.toFixed(6), y: +p.y.toFixed(6) });
	assert.deepStrictEqual(r.CoordinateB.map(round), [{ x: 100, y: 50 }, { x: 100, y: 52 }, { x: 98, y: 50 }, { x: 92, y: 56 }]);
	assert.throws(() => coordinateConvert({ CoordinateA1: { x: 0, y: 0 } }), /Missing/);
});

test("security: TOTP generate/verify/replay, rate limiter, API token format", () => {
	const secret = sec.totpSecret();
	assert.match(secret, /^[A-Z2-7]{32}$/);
	const t = Date.now();
	const code = sec.totpCode(secret, t);
	assert.ok(sec.totpVerify(secret, code, "k1", t));
	assert.ok(!sec.totpVerify(secret, code, "k1", t), "same code cannot be reused");
	assert.ok(!sec.totpVerify(secret, "000000", "k2", t) || sec.totpCode(secret, t) === "000000");
	// RFC 6238 附录 B 测试向量（SHA1，密钥 "12345678901234567890"）
	const rfc = sec.base32Encode(Buffer.from("12345678901234567890"));
	assert.strictEqual(sec.totpCode(rfc, 59 * 1000).slice(-6), "287082");
	assert.strictEqual(sec.totpCode(rfc, 1111111109 * 1000), "081804");

	const rl = new sec.RateLimiter();
	let ok = 0;
	for (let i = 0; i < 30; i++) if (rl.allow("ip", 5, 10)) ok++;
	assert.strictEqual(ok, 10, "burst then throttled");
	assert.ok(rl.allow("ip", 0, 0), "rate 0 = unlimited");
	rl.stop();

	const tok = sec.newApiToken();
	const parsed = sec.parseApiToken(tok.token);
	assert.strictEqual(parsed.id, tok.id);
	assert.ok(sec.safeEqualHex(parsed.hash, tok.hash));
	assert.strictEqual(sec.parseApiToken("psk_bad"), null);
});

test("scheduler helpers: prewarm hours window, UE launch args", () => {
	const at = (h) => new Date(2026, 0, 1, h, 30);
	assert.ok(inHours("", at(3)));
	assert.ok(inHours("8-20", at(8)) && inHours("8-20", at(19)) && !inHours("8-20", at(20)) && !inHours("8-20", at(7)));
	assert.ok(inHours("22-6", at(23)) && inHours("22-6", at(2)) && !inHours("22-6", at(12)), "crosses midnight");
	const args = buildArgs({ args: "-ResX=2560 -PixelStreamingURL=ws://old", res_x: 1920, res_y: 1080, fps: 60, audio: true, max_bitrate_mbps: 20, min_bitrate_mbps: 2 }, "ws://gw:88/ue/p/i", 1);
	assert.ok(args.includes("-ResX=2560") && !args.includes("-ResX=1920"), "user flag wins");
	assert.ok(!args.includes("-PixelStreamingURL=ws://old") && args.includes("-PixelStreamingURL=ws://gw:88/ue/p/i"), "platform URL always wins");
	assert.ok(args.includes("-graphicsadapter=1") && args.includes("-AudioMixer") && args.includes("-PixelStreamingWebRTCFps=60"));
	assert.ok(args.includes("-PixelStreamingWebRTCMaxBitrate=20000000") && args.includes("-PixelStreamingWebRTCMinBitrate=2000000"));
});

test("logger: ring buffer filtering by level, keyword and cursor", () => {
	const log = createLogger({ level: "debug", console: false });
	log.debug("d1");
	log.info("hello world");
	log.warn("disk almost full");
	log.error(new Error("boom"));
	assert.strictEqual(log.recent({ level: "warn" }).length, 2);
	assert.strictEqual(log.recent({ q: "WORLD" })[0].msg, "hello world");
	const all = log.recent();
	assert.strictEqual(log.recent({ after: all[1].seq }).length, 2);
	assert.match(log.recent({ level: "error" })[0].msg, /boom/);
});
