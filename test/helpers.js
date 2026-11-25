"use strict";
// 测试公共工具：HTTP 请求（自动跟随会话 Cookie）、WebSocket 客户端、模拟 Agent / UE / 观众
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { loadConfig } = require("../src/config.js");
const { createApp } = require("../src/app.js");
const { createLogger } = require("../src/logger.js");

const ROOT = path.join(__dirname, "..");

async function startPlatform(overrides = {}) {
	const base = 23000 + Math.floor(Math.random() * 5000);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psp-"));
	const config = loadConfig({ baseDir: dir, env: {}, overrides: { http: { port: base, publicPort: base + 1, host: "127.0.0.1" }, localAgent: { enable: false }, log: { level: "warn", file: false }, ...overrides } });
	const log = createLogger({ level: "info", console: false });
	const app = createApp({ config, assetsDir: ROOT, selfCommand: [process.execPath, path.join(ROOT, "server.js")], log, env: { PS_ADMIN_PASSWORD: "Admin12345" } });
	await app.start();
	const ctx = { app, dir, config, ADMIN: base, PUB: base + 1, cookie: "" };
	ctx.request = (port, method, p, { body, headers = {}, auth = true, raw } = {}) =>
		new Promise((resolve, reject) => {
			const data = body === undefined ? null : JSON.stringify(body);
			const h = { ...headers };
			if (data) h["Content-Type"] = "application/json";
			if (method !== "GET" && h["X-PS-Request"] === undefined && !h.Authorization) h["X-PS-Request"] = "1";
			if (auth && ctx.cookie && !h.Authorization) h.Cookie = ctx.cookie;
			const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
				const sc = (res.headers["set-cookie"] || []).find((c) => c.startsWith("ps_session="));
				if (auth && sc && !h.Authorization) ctx.cookie = /^ps_session=;/.test(sc) ? "" : sc.split(";")[0];
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
	ctx.api = (method, p, body, opts = {}) => ctx.request(ctx.ADMIN, method, p, { body, ...opts });
	ctx.login = async (username = "admin", password = "Admin12345", code) => ctx.api("POST", "/api/v1/auth/login", { username, password, code });
	ctx.agent = async (id, gpus = []) => {
		const ws = await wsClient(`ws://127.0.0.1:${ctx.ADMIN}/agent?token=${app.secrets.agentToken}&id=${id}`, "ps-agent");
		ws.send(JSON.stringify({ type: "hello", machineId: id, hostname: id, platform: "test", version: "t", cpus: 8, memTotalMB: 32000, gpus }));
		await sleep(80);
		return ws;
	};
	ctx.player = (p, headers) => wsClient(`ws://127.0.0.1:${ctx.PUB}${p}`, "peer-stream", headers);
	ctx.stop = () => app.stop();
	return ctx;
}

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
const text = (m) => typeof m === "string";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startPlatform, wsClient, next, type, text, sleep };
