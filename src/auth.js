"use strict";
/**
 * 认证与授权：scrypt 口令哈希、HS256 JWT、角色、登录限速。全部基于 Node 内置 crypto，无第三方依赖。
 */
const crypto = require("crypto");

const ROLES = { viewer: 1, operator: 2, admin: 3 };
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
	return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
	const parts = String(stored || "").split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [, N, r, p, saltB64, hashB64] = parts;
	const expect = Buffer.from(hashB64, "base64");
	let got;
	try {
		got = crypto.scryptSync(String(password), Buffer.from(saltB64, "base64"), expect.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
	} catch {
		return false;
	}
	return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

/**
 * 异步校验（scrypt 在线程池中执行，不阻塞事件循环——信令与登录共用一个进程，同步 scrypt 每次会卡住 30~60ms）
 */
function verifyPasswordAsync(password, stored) {
	return new Promise((resolve) => {
		const parts = String(stored || "").split("$");
		if (parts.length !== 6 || parts[0] !== "scrypt") return resolve(false);
		const [, N, r, p, saltB64, hashB64] = parts;
		const expect = Buffer.from(hashB64, "base64");
		crypto.scrypt(String(password), Buffer.from(saltB64, "base64"), expect.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 }, (err, got) => {
			resolve(!err && got.length === expect.length && crypto.timingSafeEqual(got, expect));
		});
	});
}

/** 口令强度：至少 8 位，包含字母与数字 */
function checkPasswordPolicy(password) {
	const s = String(password || "");
	if (s.length < 8) return "口令至少 8 位";
	if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return "口令需同时包含字母和数字";
	return null;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function signJwt(payload, secret, ttlSec) {
	const now = Math.floor(Date.now() / 1000);
	const body = { iat: now, ...payload };
	if (ttlSec) body.exp = now + ttlSec;
	const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const data = `${head}.${b64u(JSON.stringify(body))}`;
	const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
	return `${data}.${sig}`;
}

function verifyJwt(token, secret) {
	const parts = String(token || "").split(".");
	if (parts.length !== 3) return null;
	const expect = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
	let sig;
	try {
		sig = Buffer.from(parts[2], "base64url");
	} catch {
		return null;
	}
	if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return null;
	let head;
	let body;
	try {
		head = JSON.parse(Buffer.from(parts[0], "base64url").toString());
		body = JSON.parse(Buffer.from(parts[1], "base64url").toString());
	} catch {
		return null;
	}
	if (head.alg !== "HS256") return null;
	if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
	return body;
}

function hasRole(role, required) {
	return (ROLES[role] || 0) >= (ROLES[required] || 99);
}

/** 登录失败限速：同一 IP 连续失败 maxFails 次后锁定 lockMs */
class LoginLimiter {
	constructor({ maxFails = 5, lockMs = 5 * 60 * 1000 } = {}) {
		this.maxFails = maxFails;
		this.lockMs = lockMs;
		this.map = new Map();
	}
	isLocked(ip) {
		const e = this.map.get(ip);
		if (!e) return 0;
		if (e.lockUntil && e.lockUntil > Date.now()) return Math.ceil((e.lockUntil - Date.now()) / 1000);
		if (e.lockUntil) this.map.delete(ip);
		return 0;
	}
	fail(ip) {
		let e = this.map.get(ip);
		// 失败次数只在一个锁定时长的窗口内累计：几天前偶尔输错的次数不再计入（否则一次手误就可能被锁定）
		if (!e || (!e.lockUntil && Date.now() - e.last > this.lockMs)) e = { fails: 0 };
		e.last = Date.now();
		e.fails++;
		if (e.fails >= this.maxFails) e.lockUntil = Date.now() + this.lockMs;
		this.map.set(ip, e);
		if (this.map.size > 10000) this.map.delete(this.map.keys().next().value);
	}
	success(ip) {
		this.map.delete(ip);
	}
}

function parseCookies(header) {
	const out = {};
	for (const part of String(header || "").split(";")) {
		const i = part.indexOf("=");
		if (i <= 0) continue;
		const v = part.slice(i + 1).trim();
		try {
			out[part.slice(0, i).trim()] = decodeURIComponent(v);
		} catch {
			out[part.slice(0, i).trim()] = v; // 非法 % 编码：按原样保留，不抛异常
		}
	}
	return out;
}

module.exports = { ROLES, hashPassword, verifyPassword, verifyPasswordAsync, checkPasswordPolicy, signJwt, verifyJwt, hasRole, LoginLimiter, parseCookies };
