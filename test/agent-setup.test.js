"use strict";
// Agent 安装包：数据段格式、上传校验、安装链接（附带平台配置）、从安装程序解压 Agent、令牌校验、从发布页获取、Agent --config
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const { startPlatform } = require("./helpers.js");
const { AgentPackages, trailer, configSection, readSections, agentPayload, AGENT_TAG, CONFIG_TAG } = require("../src/downloads.js");
const { parseArgs } = require("../agent/agent.js");

const silent = { info() {}, warn() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "psp-dl-"));

/** 模拟安装程序：MZ 向导 + [原始大小][gzip(Agent)] + 尾标 */
function fakeSetup(agent, stubSize = 1100000) {
	const stub = Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(stubSize)]);
	const gz = zlib.gzipSync(agent);
	const size = Buffer.alloc(8);
	size.writeBigUInt64LE(BigInt(agent.length));
	return Buffer.concat([stub, size, gz, trailer(8 + gz.length, AGENT_TAG)]);
}

function raw(port, method, p, { body, headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

test("数据段：附加配置后仍能读出 Agent，离末尾最近的配置生效", () => {
	const dir = tmpDir();
	const agent = Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(5000)]);
	const f = path.join(dir, "setup.exe");
	fs.writeFileSync(f, Buffer.concat([fakeSetup(agent, 100), configSection({ token: "old" }), configSection({ token: "new" })]));
	const { sections, stubLength } = readSections(f);
	assert.deepStrictEqual(
		sections.map((s) => s.tag),
		[CONFIG_TAG, CONFIG_TAG, AGENT_TAG]
	);
	assert.strictEqual(stubLength, 102);
	const buf = fs.readFileSync(f);
	const c = sections[0];
	assert.strictEqual(JSON.parse(buf.subarray(c.offset, c.offset + c.length)).token, "new");
	const p = agentPayload(f);
	assert.strictEqual(p.size, agent.length);
	assert.ok(zlib.gunzipSync(buf.subarray(p.start, p.end + 1)).equals(agent));
	// 没有数据段的普通文件
	fs.writeFileSync(f, Buffer.from("MZ plain exe"));
	assert.strictEqual(readSections(f).sections.length, 0);
	assert.strictEqual(agentPayload(f), null);
});

test("安装包上传：校验文件头、压缩包、缺少 Agent 的 exe、过小文件", async () => {
	const pk = new AgentPackages({ dir: tmpDir(), version: "9.9.9", log: silent, minSize: 1000 });
	const from = (b) => [b];
	await assert.rejects(pk.save("windows", from(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(2000)]))), /压缩包/);
	await assert.rejects(pk.save("linux", from(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2000)]))), /文件类型不对/);
	await assert.rejects(pk.save("windows", from(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2000)]))), /不是 Agent 安装程序/);
	await assert.rejects(pk.save("windows", from(Buffer.from("MZ"))), /过小/);
	await assert.rejects(pk.save("macos", from(Buffer.from("x"))), /不支持/);
	const ok = await pk.save("windows", from(fakeSetup(Buffer.alloc(3000, 7), 1200)), { origin: "upload", by: "admin" });
	assert.strictEqual(ok.sha256.length, 64);
	const st = pk.status();
	assert.strictEqual(st.targets.windows.available, true);
	assert.strictEqual(st.targets.windows.source, "upload");
	assert.strictEqual(st.targets.linux.available, false);
	assert.strictEqual(st.targets.windows.asset, "ps-platform-agent-setup-9.9.9.exe");
	// 失败的上传不留下临时文件
	assert.deepStrictEqual(
		fs.readdirSync(pk.dir).filter((n) => n.endsWith(".part")),
		[]
	);
	assert.strictEqual(pk.remove("windows"), true);
	assert.strictEqual(pk.remove("windows"), false);
});

test("从发布页获取：成功保存并记录版本；404 给出可读原因", async () => {
	const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), crypto.randomBytes(4000)]);
	const fetchImpl = async (url) => (url.endsWith("ps-platform-agent-2.0.0-linux-x64") ? new Response(elf, { headers: { "content-length": String(elf.length) } }) : new Response("nope", { status: 404 }));
	const pk = new AgentPackages({ dir: tmpDir(), version: "2.0.0", releaseBaseUrl: "https://example.test/releases/download/v{version}/", log: silent, fetchImpl, minSize: 1000 });
	assert.strictEqual(pk.releasePage(), "https://example.test/releases/tag/v2.0.0");
	const job = pk.startFetch("linux", "admin");
	assert.strictEqual(job.url, "https://example.test/releases/download/v2.0.0/ps-platform-agent-2.0.0-linux-x64");
	for (let i = 0; i < 50 && job.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	assert.strictEqual(job.state, "done");
	const t = pk.status().targets.linux;
	assert.strictEqual(t.source, "release");
	assert.strictEqual(t.version, "2.0.0");
	assert.ok(fs.readFileSync(pk.resolve("linux").path).equals(elf));
	const bad = pk.startFetch("windows");
	for (let i = 0; i < 50 && bad.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	assert.strictEqual(bad.state, "error");
	assert.match(bad.error, /HTTP 404/);
	assert.throws(() => new AgentPackages({ dir: tmpDir(), version: "1", log: silent }).startFetch("linux"), /未配置发布页地址/);
});

test("平台：上传安装程序 → 安装链接下载附带配置 → 解压 Agent → 令牌校验", async () => {
	const ctx = await startPlatform();
	try {
		await ctx.login();
		const agent = Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(20000)]);
		const setup = fakeSetup(agent);
		const auth = { Cookie: ctx.cookie, "X-PS-Request": "1", "Content-Type": "application/octet-stream" };

		// 上传：错误类型返回原因；正确文件保存
		let r = await raw(ctx.ADMIN, "PUT", "/api/v1/agent-packages/windows", { body: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(1100000)]), headers: auth });
		assert.strictEqual(r.status, 400);
		assert.match(JSON.parse(r.body).error, /不是 Agent 安装程序/);
		r = await raw(ctx.ADMIN, "PUT", "/api/v1/agent-packages/windows", { body: setup, headers: auth });
		assert.strictEqual(r.status, 200, r.body.toString());
		assert.strictEqual(JSON.parse(r.body).source, "upload");
		// 上传需要管理员：未登录 401（请求体要小：服务器不读取就返回，大请求体可能在客户端写入时被重置连接）
		r = await raw(ctx.ADMIN, "PUT", "/api/v1/agent-packages/windows", { body: Buffer.from("MZ"), headers: { "X-PS-Request": "1" } });
		assert.strictEqual(r.status, 401);

		const st = await ctx.api("GET", "/api/v1/agent-packages");
		assert.strictEqual(st.body.targets.windows.available, true);
		assert.match(st.body.downloads.windowsExe, /\/download\/agent\/windows-exe$/);

		// 安装链接：附带平台地址与当前接入令牌
		const link = await ctx.api("POST", "/api/v1/agent-setup-link");
		assert.strictEqual(link.status, 200);
		assert.ok(link.body.available);
		const u = new URL(link.body.url);
		const dl = await raw(ctx.ADMIN, "GET", u.pathname + u.search);
		assert.strictEqual(dl.status, 200);
		assert.strictEqual(Number(dl.headers["content-length"]), dl.body.length);
		assert.match(dl.headers["content-disposition"], /ps-platform-agent-setup\.exe/);
		const f = path.join(ctx.dir, "dl.exe");
		fs.writeFileSync(f, dl.body);
		const c = readSections(f).sections[0];
		assert.strictEqual(c.tag, CONFIG_TAG);
		const cfg = JSON.parse(dl.body.subarray(c.offset, c.offset + c.length));
		assert.strictEqual(cfg.token, ctx.app.secrets.agentToken);
		assert.strictEqual(cfg.url, `ws://127.0.0.1:${ctx.ADMIN}/agent`);
		assert.strictEqual(cfg.platform, `http://127.0.0.1:${ctx.ADMIN}`);
		assert.ok(dl.body.subarray(0, setup.length).equals(setup));

		// 无效 / 篡改的链接、观众口都拿不到
		assert.strictEqual((await raw(ctx.ADMIN, "GET", "/download/agent/windows-setup?k=bogus")).status, 403);
		assert.strictEqual((await raw(ctx.ADMIN, "GET", u.pathname + u.search.slice(0, -3) + "abc")).status, 403);
		assert.strictEqual((await raw(ctx.PUB, "GET", u.pathname + u.search)).status, 404);
		// 会话令牌不能当安装链接用
		const session = ctx.cookie.split("=")[1];
		assert.strictEqual((await raw(ctx.ADMIN, "GET", `/download/agent/windows-setup?k=${session}`)).status, 403);

		// 命令行用的 Agent 程序：从安装程序中解压
		const exe = await raw(ctx.ADMIN, "GET", "/download/agent/windows-exe");
		assert.strictEqual(exe.status, 200);
		assert.ok(exe.body.equals(agent));
		assert.strictEqual(Number(exe.headers["content-length"]), agent.length);
		assert.strictEqual((await raw(ctx.ADMIN, "GET", "/download/agent/linux")).status, 404);
		assert.strictEqual((await raw(ctx.ADMIN, "GET", "/download/agent/macos")).status, 404);

		// 安装向导「检测连接」
		const ok = await raw(ctx.ADMIN, "GET", "/agent/check", { headers: { "X-Agent-Token": ctx.app.secrets.agentToken } });
		assert.strictEqual(ok.status, 200);
		assert.strictEqual(JSON.parse(ok.body).ok, true);
		assert.strictEqual((await raw(ctx.ADMIN, "GET", "/agent/check", { headers: { "X-Agent-Token": "wrong" } })).status, 401);
		assert.strictEqual((await raw(ctx.ADMIN, "GET", "/agent/check")).status, 401);

		// 接入说明中的命令
		const info = await ctx.api("GET", "/api/v1/agent-install");
		assert.match(info.body.windowsDownload, /windows-exe/);
		assert.match(info.body.windowsSilent, /\/S/);
		assert.ok(!/D:\\UEProject\\"/.test(info.body.windows), "Windows 路径不能以 \\\" 结尾");

		// 删除
		assert.strictEqual((await ctx.api("DELETE", "/api/v1/agent-packages/windows")).status, 200);
		assert.strictEqual((await ctx.api("DELETE", "/api/v1/agent-packages/windows")).status, 404);
		assert.strictEqual((await raw(ctx.ADMIN, "GET", u.pathname + u.search)).status, 404);
		const audit = await ctx.api("GET", "/api/v1/audit?limit=50");
		const actions = (audit.body.items || audit.body).map((a) => a.action);
		for (const a of ["agent_package.upload", "agent.setup_link", "agent.setup_download", "agent_package.delete"]) assert.ok(actions.includes(a), a);
	} finally {
		await ctx.stop();
	}
});

test("Agent --config：读取安装程序写入的配置，命令行参数优先，去掉误带的引号", () => {
	const dir = tmpDir();
	const f = path.join(dir, "agent.json");
	fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ url: "ws://10.0.0.1:88/agent", token: "t1", id: "pc-1", allowExe: ["D:\\UE"], state: "s.json" }));
	let o = parseArgs(["--config", f]);
	assert.strictEqual(o.url, "ws://10.0.0.1:88/agent");
	assert.strictEqual(o.token, "t1");
	assert.strictEqual(o.id, "pc-1");
	assert.deepStrictEqual(o.allowExe, ["D:\\UE"]);
	assert.strictEqual(o.state, "s.json");
	o = parseArgs(["--config", f, "--id", "pc-2", "--allow-exe", 'D:\\Other"']);
	assert.strictEqual(o.id, "pc-2");
	assert.deepStrictEqual(o.allowExe, ["D:\\Other"]);
	assert.throws(() => parseArgs(["--config", path.join(dir, "missing.json")]), /无法读取 Agent 配置文件/);
});
