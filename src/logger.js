"use strict";
/**
 * 日志：控制台 + 按天滚动的文件（data/logs/platform-YYYY-MM-DD.log，超过保留天数自动删除）
 * + 内存环形缓冲（管理端「日志」页面实时查看/过滤，无需读文件）。
 */
const fs = require("fs");
const path = require("path");
const util = require("util");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger({ level = "info", dir = null, retentionDays = 14, bufferSize = 3000, console: toConsole = true } = {}) {
	let min = LEVELS[level] ?? 20;
	const buffer = [];
	let seq = 0;
	let day = "";
	let stream = null;

	const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	function fileStream(now) {
		if (!dir) return null;
		const d = localDay(now);
		if (d !== day || !stream) {
			day = d;
			try {
				stream?.end();
				fs.mkdirSync(dir, { recursive: true });
				stream = fs.createWriteStream(path.join(dir, `platform-${d}.log`), { flags: "a" });
				stream.on("error", () => (stream = null));
				cleanup();
			} catch {
				stream = null;
			}
		}
		return stream;
	}
	function cleanup() {
		try {
			const cutoff = Date.now() - retentionDays * 86400000;
			for (const f of fs.readdirSync(dir)) {
				if (!/^platform-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
				const p = path.join(dir, f);
				if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
			}
		} catch {}
	}

	function write(lv, args) {
		if (LEVELS[lv] < min) return;
		const now = new Date();
		const msg = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : util.inspect(a, { depth: 4, breakLength: 200 }))).join(" ");
		const entry = { seq: ++seq, t: now.getTime(), level: lv, msg };
		buffer.push(entry);
		if (buffer.length > bufferSize) buffer.shift();
		const line = `${now.toISOString()} ${lv.toUpperCase().padEnd(5)} ${msg}`;
		if (toConsole) (lv === "error" ? console.error : lv === "warn" ? console.warn : console.log)(line);
		fileStream(now)?.write(line + "\n");
	}

	const logger = {
		debug: (...a) => write("debug", a),
		info: (...a) => write("info", a),
		warn: (...a) => write("warn", a),
		error: (...a) => write("error", a),
		/** 运行中调整（管理端「系统参数」修改后立即生效） */
		setLevel(lv) {
			if (LEVELS[lv] !== undefined) min = LEVELS[lv];
		},
		setRetentionDays(n) {
			if (n > 0) {
				retentionDays = n;
				if (dir) cleanup();
			}
		},
		/** 管理端查询：level 以上、包含关键字、seq 之后 */
		recent({ level: lv = "debug", q = "", after = 0, limit = 500 } = {}) {
			const m = LEVELS[lv] ?? 10;
			const needle = String(q || "").toLowerCase();
			const out = [];
			for (let i = buffer.length - 1; i >= 0 && out.length < limit; i--) {
				const e = buffer[i];
				if (e.seq <= after) break;
				if (LEVELS[e.level] < m) continue;
				if (needle && !e.msg.toLowerCase().includes(needle)) continue;
				out.push(e);
			}
			return out.reverse();
		},
		/** 把子进程的输出逐行并入日志 */
		pipe(readable, prefix, lv = "info") {
			let rest = "";
			readable.setEncoding("utf8");
			readable.on("data", (chunk) => {
				const lines = (rest + chunk).split(/\r?\n/);
				rest = lines.pop();
				for (const l of lines) if (l.trim()) write(/\berror\b|失败|exited/i.test(l) ? "warn" : lv, [`${prefix} ${l}`]);
			});
		},
		close() {
			stream?.end();
			stream = null;
		},
		dir,
	};
	return logger;
}

module.exports = { createLogger, LEVELS };
