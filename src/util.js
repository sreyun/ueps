"use strict";
const crypto = require("crypto");
const os = require("os");
const { cidrMatcher, normalizeIp, isPrivateIp, resolveRequestHost } = require("../lib/turn-tcp.js");

/** 短随机 ID（URL 安全，小写字母+数字） */
function newId(len = 10) {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
	const bytes = crypto.randomBytes(len);
	let s = "";
	for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
	return s;
}

function randomSecret(bytes = 32) {
	return crypto.randomBytes(bytes).toString("hex");
}

/** 本机第一个私网 IPv4（UE 连接平台用的地址的默认值） */
function firstLanIPv4() {
	const all = Object.values(os.networkInterfaces()).flat().filter(Boolean);
	const v4 = all.filter((a) => (a.family === "IPv4" || a.family === 4) && !a.internal);
	return (v4.find((a) => isPrivateIp(a.address)) || v4[0] || { address: "127.0.0.1" }).address;
}

/** 列表（CIDR/IP）匹配器，带缓存；list 为 null 表示"不限制" */
const matcherCache = new Map();
function ipInList(list, ip) {
	if (!Array.isArray(list)) return null;
	const key = JSON.stringify(list);
	let m = matcherCache.get(key);
	if (!m) {
		const v4 = cidrMatcher(list);
		const raw = list.map(String);
		m = (addr) => v4(addr) || raw.includes(addr) || (addr === "::1" && raw.some((r) => r.startsWith("127.")));
		matcherCache.set(key, m);
	}
	return m(normalizeIp(ip));
}

/** 把一行命令行参数拆成数组（支持双引号） */
function splitArgs(str) {
	const out = [];
	const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
	let m;
	while ((m = re.exec(String(str || "")))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
	return out;
}

/** 节流：fn 在 wait 毫秒内最多执行一次，期间的调用合并为一次尾触发 */
function throttle(fn, wait) {
	let timer = null;
	let pending = false;
	return function throttled() {
		if (timer) {
			pending = true;
			return;
		}
		fn();
		timer = setTimeout(() => {
			timer = null;
			if (pending) {
				pending = false;
				throttled();
			}
		}, wait);
		timer.unref?.();
	};
}

module.exports = { newId, randomSecret, firstLanIPv4, ipInList, splitArgs, throttle, normalizeIp, isPrivateIp, resolveRequestHost };
