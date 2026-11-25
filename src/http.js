"use strict";
/**
 * 轻量 HTTP 工具：路由（含 :param）、JSON 读写、静态文件、安全响应头。
 */
const fs = require("fs");
const path = require("path");

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

class Router {
	constructor() {
		this.routes = [];
	}
	add(method, pattern, handler, opts = {}) {
		const keys = [];
		const re = new RegExp(
			"^" +
				pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_, k) => {
					keys.push(k);
					return "([^/]+)";
				}) +
				"\\/?$"
		);
		this.routes.push({ method, re, keys, handler, opts });
		return this;
	}
	get(p, h, o) {
		return this.add("GET", p, h, o);
	}
	post(p, h, o) {
		return this.add("POST", p, h, o);
	}
	put(p, h, o) {
		return this.add("PUT", p, h, o);
	}
	del(p, h, o) {
		return this.add("DELETE", p, h, o);
	}
	match(method, pathname) {
		let allowed = false;
		for (const r of this.routes) {
			const m = r.re.exec(pathname);
			if (!m) continue;
			if (r.method !== method) {
				allowed = true;
				continue;
			}
			const params = {};
			try {
				r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
			} catch {
				return null; // 非法的 % 编码
			}
			return { route: r, params };
		}
		return allowed ? { methodNotAllowed: true } : null;
	}
}

function sendJson(res, status, body, headers = {}) {
	if (res.headersSent) return res.end();
	const data = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data), ...headers });
	res.end(data);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
	if (res.headersSent) return res.end();
	res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

function readJson(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				reject(Object.assign(new Error("请求体过大"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(Object.assign(new Error("请求体不是合法的 JSON"), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

function securityHeaders(res, { admin = false } = {}) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "same-origin");
	if (admin) {
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'");
	}
}

/**
 * 把 URL 路径解析为 root 内的绝对路径；路径穿越、隐藏文件（.开头）、非法编码返回 null。
 */
function resolveSafe(root, relPath) {
	let rel;
	try {
		rel = decodeURIComponent(relPath);
	} catch {
		return null;
	}
	if (rel.includes("\0")) return null;
	rel = path.posix.normalize("/" + rel.replace(/\\/g, "/"));
	if (/(^|\/)\./.test(rel)) return null;
	const base = path.resolve(root);
	const file = path.resolve(base, "." + rel);
	return file.startsWith(base + path.sep) ? file : null;
}

/** 安全的静态文件服务：root 内的文件，拒绝路径穿越与隐藏文件 */
function serveFile(req, res, root, relPath, { cache = "no-cache" } = {}) {
	const file = resolveSafe(root, relPath);
	if (!file) return sendText(res, 404, "Not Found");
	fs.stat(file, (err, st) => {
		if (err || !st.isFile()) return sendText(res, 404, "Not Found");
		const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304);
			return res.end();
		}
		res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": st.size, ETag: etag, "Cache-Control": cache });
		if (req.method === "HEAD") return res.end();
		fs.createReadStream(file)
			.on("error", () => res.destroy())
			.pipe(res);
	});
}

module.exports = { Router, sendJson, sendText, readJson, securityHeaders, serveFile, resolveSafe, MIME };
