"use strict";
/**
 * 安全工具：TOTP 两步验证（RFC 6238，兼容 Google Authenticator / 微信小程序"腾讯身份验证器"等）、令牌桶限流、API 令牌。
 */
const crypto = require("crypto");

/* ------------------------------------------------------------------ TOTP */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}
function base32Decode(str) {
	const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
	let bits = 0;
	let value = 0;
	const out = [];
	for (const ch of s) {
		value = (value << 5) | B32.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}
function totpSecret() {
	return base32Encode(crypto.randomBytes(20));
}
function hotp(secret, counter, digits = 6) {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const h = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
	const o = h[h.length - 1] & 15;
	const code = ((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).toString();
	return code.padStart(digits, "0");
}
function totpCode(secret, t = Date.now(), step = 30) {
	return hotp(secret, Math.floor(t / 1000 / step));
}
const usedCounters = new Map(); // key -> 最近一次使用的计数器，防重放
/** 校验 6 位码，允许 ±1 个时间窗；同一个码只能用一次 */
function totpVerify(secret, code, key = secret, t = Date.now()) {
	const c = String(code || "").replace(/\s/g, "");
	if (!/^\d{6}$/.test(c)) return false;
	const now = Math.floor(t / 1000 / 30);
	for (const w of [0, -1, 1]) {
		const counter = now + w;
		const expect = hotp(secret, counter);
		if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) {
			if ((usedCounters.get(key) ?? -1) >= counter) return false;
			usedCounters.set(key, counter);
			return true;
		}
	}
	return false;
}
const otpauthUrl = (secret, account, issuer = "云渲染管理平台") => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* ------------------------------------------------------------------ 限流 */
class RateLimiter {
	constructor() {
		this.buckets = new Map();
		this.timer = setInterval(() => {
			const now = Date.now();
			for (const [k, b] of this.buckets) if (now - b.last > 60000) this.buckets.delete(k);
		}, 30000);
		this.timer.unref?.();
	}
	/** 令牌桶：每秒补充 rate 个，最多 burst 个；rate<=0 表示不限 */
	allow(key, rate, burst) {
		if (!(rate > 0)) return true;
		const now = Date.now();
		let b = this.buckets.get(key);
		if (!b) {
			if (this.buckets.size >= 200000) this.buckets.delete(this.buckets.keys().next().value); // 防止海量来源 IP 撑爆内存
			b = { tokens: burst, last: now };
			this.buckets.set(key, b);
		}
		b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * rate);
		b.last = now;
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}
	stop() {
		clearInterval(this.timer);
	}
}

/* ------------------------------------------------------------------ API 令牌 */
// 格式：psk_<id>_<secret>；数据库只保存 secret 的 SHA-256
function newApiToken() {
	const id = crypto.randomBytes(6).toString("hex");
	const secret = crypto.randomBytes(24).toString("base64url");
	return { id, token: `psk_${id}_${secret}`, hash: sha256(secret) };
}
function parseApiToken(token) {
	const m = String(token || "").match(/^psk_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/);
	return m ? { id: m[1], hash: sha256(m[2]) } : null;
}
function sha256(s) {
	return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function safeEqualHex(a, b) {
	const x = Buffer.from(String(a), "hex");
	const y = Buffer.from(String(b), "hex");
	return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { totpSecret, totpCode, totpVerify, otpauthUrl, base32Encode, base32Decode, RateLimiter, newApiToken, parseApiToken, safeEqualHex };
