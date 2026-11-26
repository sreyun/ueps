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

/** 本机的 IPv4（「接入渲染机」的地址候选，内网地址在前）：跳过回环、链路本地与常见虚拟网卡（Docker / Hyper-V / VMware / VirtualBox / WSL） */
const VIRTUAL_NIC = /^(docker|br-|veth|virbr|cni|flannel|kube|lxc|lxd)|vEthernet|VMware|VirtualBox|Hyper-V|WSL|Loopback/i;
function lanIPv4s() {
	const out = [];
	for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
		if (VIRTUAL_NIC.test(name)) continue;
		for (const a of addrs || []) {
			if ((a.family === "IPv4" || a.family === 4) && !a.internal && !a.address.startsWith("169.254.")) out.push({ address: a.address, name, private: isPrivateIp(a.address) });
		}
	}
	return out.sort((x, y) => y.private - x.private);
}

/** 主机名（可带端口）是否为回环 / 本机地址：其它机器无法用它访问本机 */
function isLoopbackHost(host) {
	let h = String(host || "")
		.trim()
		.toLowerCase();
	const m = h.match(/^\[([^\]]+)\](?::\d*)?$/);
	if (m) h = m[1];
	else if ((h.match(/:/g) || []).length === 1) h = h.replace(/:\d*$/, "");
	return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || h === "::" || /^127\./.test(h);
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

module.exports = { newId, randomSecret, firstLanIPv4, lanIPv4s, isLoopbackHost, ipInList, splitArgs, throttle, normalizeIp, isPrivateIp, resolveRequestHost };
