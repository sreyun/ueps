"use strict";
/**
 * turn-tcp.js —— 面向"无 UDP 端口映射"场景的轻量 TURN 中继（RFC 5766 / RFC 8656 子集）
 *
 *   浏览器 ──TCP/TLS(443, 经 nginx stream)──▶ turn-tcp ──UDP(仅内网)──▶ UE(libwebrtc)
 *
 * - 客户端侧只走 TCP / TLS：可直接对外，也可放在 nginx stream 后面（支持 PROXY protocol v1）。
 * - 中继侧走 UDP，但只绑定在内网地址上，只允许与白名单（allowedPeers）内的 UE 主机通信，
 *   因此公网上不需要任何 UDP 端口映射。
 * - 鉴权：TURN REST API 临时凭据（与 coturn 的 use-auth-secret/static-auth-secret 兼容）
 *   以及可选的静态账号（与 coturn 的 lt-cred-mech 兼容）。
 * - 零第三方依赖。既可被 signal.js require，也可独立运行：
 *       node turn-tcp.js [turn.json]
 *
 * 已实现：Binding / Allocate / Refresh / CreatePermission / ChannelBind / Send / Data / ChannelData，
 *        长期凭据 MESSAGE-INTEGRITY、FINGERPRINT、无状态 NONCE、配额、生存期、背压丢包。
 * 未实现：TCP 中继分配(RFC 6062)、IPv6 中继、MESSAGE-INTEGRITY-SHA256（浏览器均不需要）。
 */

const net = require("net");
const tls = require("tls");
const dgram = require("dgram");
const crypto = require("crypto");
const os = require("os");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const MAGIC = 0x2112a442;
const SOFTWARE = "peer-stream turn-tcp 1.1";
const PADDING = [null, Buffer.alloc(1), Buffer.alloc(2), Buffer.alloc(3)];

const METHOD = {
	BINDING: 0x001,
	ALLOCATE: 0x003,
	REFRESH: 0x004,
	SEND: 0x006,
	DATA: 0x007,
	CREATE_PERMISSION: 0x008,
	CHANNEL_BIND: 0x009,
};
const CLASS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 };
const ATTR = {
	MAPPED_ADDRESS: 0x0001,
	USERNAME: 0x0006,
	MESSAGE_INTEGRITY: 0x0008,
	ERROR_CODE: 0x0009,
	CHANNEL_NUMBER: 0x000c,
	LIFETIME: 0x000d,
	XOR_PEER_ADDRESS: 0x0012,
	DATA: 0x0013,
	REALM: 0x0014,
	NONCE: 0x0015,
	XOR_RELAYED_ADDRESS: 0x0016,
	REQUESTED_ADDRESS_FAMILY: 0x0017,
	EVEN_PORT: 0x0018,
	REQUESTED_TRANSPORT: 0x0019,
	DONT_FRAGMENT: 0x001a,
	XOR_MAPPED_ADDRESS: 0x0020,
	RESERVATION_TOKEN: 0x0022,
	SOFTWARE: 0x8022,
	FINGERPRINT: 0x8028,
};
const ERR = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	437: "Allocation Mismatch",
	438: "Stale Nonce",
	440: "Address Family not Supported",
	441: "Wrong Credentials",
	442: "Unsupported Transport Protocol",
	486: "Allocation Quota Reached",
	500: "Server Error",
	508: "Insufficient Capacity",
};

const DEFAULTS = {
	listen: ["127.0.0.1:3478"], // TCP 监听（给 nginx stream 用），可多个
	tls: null, // { listen: ["0.0.0.0:5349"], cert: "path", key: "path" } 不经 nginx 直接提供 TURNS 时使用
	relayIp: "auto", // 中继 UDP 绑定地址（必须是 UE 能访问到的内网地址）
	externalIp: null, // 通告给客户端的中继地址，默认等于 relayIp。注意：不要填公网 IP！
	minPort: 49160,
	maxPort: 50159, // 每个浏览器 PeerConnection 可能占 1~2 个中继端口（多网卡时），按并发数 × 3 预留
	realm: "peer-stream",
	secret: "", // TURN REST API 共享密钥
	users: {}, // 静态账号 { "user": "password" }
	allowedPeers: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"],
	deniedPeers: ["0.0.0.0/8", "169.254.0.0/16", "224.0.0.0/3"],
	allowedPeerPorts: [1024, 65535],
	trustedProxies: ["127.0.0.1", "::1"], // 只有来自这些地址的连接才解析 PROXY protocol 头
	proxyProtocol: true, // 自动识别 nginx `proxy_protocol on;` 发来的 PROXY v1 头
	// 同端口明文 HTTP："host:port"。非 TLS 连接的首包若是 HTTP 请求（而不是 STUN），带 PROXY v1 头转交给该地址
	// （nginx `listen ... proxy_protocol` 的 http server），使 http://IP:端口/ 网页、ws:// 信令与 TURN 共用一个端口
	httpFallback: null,
	defaultLifetime: 600,
	maxLifetime: 3600,
	maxAllocations: 500,
	maxAllocationsPerUser: 8,
	maxBufferedBytes: 1 << 20, // 单连接 TCP 待发数据的硬上限
	maxQueueMs: 300, // 自适应上限：待发数据超过"该连接实测码率 × 300ms"即丢包，过载时以丢包换低延迟
	minQueueBytes: 128 * 1024, // 自适应上限的下限（保证关键帧突发能完整通过）
	udpRecvBuffer: 512 * 1024, // 中继 UDP 接收缓冲：足以吸收关键帧突发，又不至于在 CPU 过载时堆积数秒延迟（Linux 受 net.core.rmem_max 限制）
	udpSendBuffer: 1 << 20,
	idleTimeout: 120, // 秒：连接建立后多久内没有成功分配就断开
	nonceTtl: 600,
	log: console,
	debug: false,
};

/* ---------------------------------------------------------------- utils */

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function normalizeIp(ip) {
	if (typeof ip !== "string") return "";
	const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	return m ? m[1] : ip;
}

function ipv4ToInt(ip) {
	const p = ip.split(".");
	if (p.length !== 4) return null;
	let n = 0;
	for (const s of p) {
		if (!/^\d{1,3}$/.test(s) || +s > 255) return null;
		n = n * 256 + +s;
	}
	return n >>> 0;
}

/** 解析 CIDR / 单个 IPv4 列表，返回匹配函数 */
function cidrMatcher(list) {
	const rules = [];
	for (const item of list || []) {
		const [ip, bitsStr] = String(item).trim().split("/");
		const base = ipv4ToInt(ip);
		if (base === null) continue;
		const bits = bitsStr === undefined ? 32 : Math.max(0, Math.min(32, +bitsStr));
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		rules.push([(base & mask) >>> 0, mask]);
	}
	return (ip) => {
		const n = ipv4ToInt(normalizeIp(ip));
		if (n === null) return false;
		return rules.some(([base, mask]) => ((n & mask) >>> 0) === base);
	};
}

function ipv6ToBuffer(ip) {
	let [head, tail] = ip.split("::");
	const h = head ? head.split(":") : [];
	const t = tail !== undefined && tail ? tail.split(":") : [];
	const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
	const b = Buffer.alloc(16);
	groups.slice(0, 8).forEach((g, i) => b.writeUInt16BE(parseInt(g || "0", 16) & 0xffff, i * 2));
	return b;
}

function firstLanIPv4() {
	const all = Object.values(os.networkInterfaces()).flat().filter(Boolean);
	const v4 = all.filter((a) => (a.family === "IPv4" || a.family === 4) && !a.internal);
	const isPrivate = cidrMatcher(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
	return (v4.find((a) => isPrivate(a.address)) || v4[0] || { address: "127.0.0.1" }).address;
}

function parseHostPort(s, defHost = "0.0.0.0") {
	if (typeof s === "number") return { host: defHost, port: s };
	const str = String(s);
	const m = str.match(/^\[(.+)\]:(\d+)$/) || str.match(/^(.*):(\d+)$/);
	if (m) return { host: m[1] || defHost, port: +m[2] };
	return { host: defHost, port: +str };
}

/* ---------------------------------------------------------- STUN codec */

function encType(method, cls) {
	return (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
}
function decType(t) {
	return {
		method: (t & 0x000f) | ((t & 0x00e0) >> 1) | ((t & 0x3e00) >> 2),
		cls: ((t & 0x0010) >> 4) | ((t & 0x0100) >> 7),
	};
}

function parseStun(buf) {
	if (buf.length < 20) return null;
	const type = buf.readUInt16BE(0);
	const len = buf.readUInt16BE(2);
	if (type & 0xc000 || len % 4 || len + 20 !== buf.length) return null;
	if (buf.readUInt32BE(4) !== MAGIC) return null;
	const { method, cls } = decType(type);
	const msg = { method, cls, tid: buf.subarray(8, 20), raw: buf, attrs: new Map(), miOffset: -1, hasFingerprint: false };
	let off = 20;
	while (off + 4 <= buf.length) {
		const at = buf.readUInt16BE(off);
		const al = buf.readUInt16BE(off + 2);
		if (off + 4 + al > buf.length) return null;
		const value = buf.subarray(off + 4, off + 4 + al);
		if (at === ATTR.FINGERPRINT) msg.hasFingerprint = true;
		else if (msg.miOffset < 0) {
			if (at === ATTR.MESSAGE_INTEGRITY) msg.miOffset = off;
			if (!msg.attrs.has(at)) msg.attrs.set(at, value); // 只取第一个同名属性；MI 之后的属性忽略
			else if (at === ATTR.XOR_PEER_ADDRESS) (msg.extraPeers ||= []).push(value);
		}
		off += 4 + ((al + 3) & ~3);
	}
	return msg;
}

function decodeXorAddress(v, tid) {
	if (!v || v.length < 8) return null;
	const family = v[1];
	const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
	if (family === 0x01) {
		const a = (v.readUInt32BE(4) ^ MAGIC) >>> 0;
		return { family: 4, port, address: `${a >>> 24}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}` };
	}
	if (family === 0x02 && v.length >= 20) {
		const key = Buffer.alloc(16);
		key.writeUInt32BE(MAGIC, 0);
		tid.copy(key, 4);
		const parts = [];
		for (let i = 0; i < 16; i += 2) parts.push(((v[4 + i] ^ key[i]) * 256 + (v[5 + i] ^ key[i + 1])).toString(16));
		return { family: 6, port, address: parts.join(":") };
	}
	return null;
}

function encodeXorAddress(address, port, tid) {
	const ip = normalizeIp(address);
	if (net.isIPv4(ip)) {
		const b = Buffer.alloc(8);
		b[1] = 0x01;
		b.writeUInt16BE((port ^ (MAGIC >>> 16)) & 0xffff, 2);
		b.writeUInt32BE((ipv4ToInt(ip) ^ MAGIC) >>> 0, 4);
		return b;
	}
	const raw = ipv6ToBuffer(ip);
	const key = Buffer.alloc(16);
	key.writeUInt32BE(MAGIC, 0);
	tid.copy(key, 4);
	const b = Buffer.alloc(20);
	b[1] = 0x02;
	b.writeUInt16BE((port ^ (MAGIC >>> 16)) & 0xffff, 2);
	for (let i = 0; i < 16; i++) b[4 + i] = raw[i] ^ key[i];
	return b;
}

function attr(type, value) {
	return { type, value: Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8") };
}
function u32(n) {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0, 0);
	return b;
}
function errorCodeValue(code) {
	const reason = Buffer.from(ERR[code] || "Error", "utf8");
	const b = Buffer.alloc(4 + reason.length);
	b[2] = Math.floor(code / 100);
	b[3] = code % 100;
	reason.copy(b, 4);
	return b;
}

function buildStun(method, cls, tid, attrs, key, fingerprint) {
	const parts = [];
	let len = 0;
	for (const a of attrs) {
		const pad = (4 - (a.value.length % 4)) % 4;
		const h = Buffer.alloc(4);
		h.writeUInt16BE(a.type, 0);
		h.writeUInt16BE(a.value.length, 2);
		parts.push(h, a.value);
		if (pad) parts.push(Buffer.alloc(pad));
		len += 4 + a.value.length + pad;
	}
	const header = Buffer.alloc(20);
	header.writeUInt16BE(encType(method, cls), 0);
	header.writeUInt32BE(MAGIC, 4);
	tid.copy(header, 8);
	if (key) {
		header.writeUInt16BE(len + 24, 2);
		const body = Buffer.concat(parts);
		const mac = crypto.createHmac("sha1", key).update(header).update(body).digest();
		const h = Buffer.alloc(4);
		h.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, 0);
		h.writeUInt16BE(20, 2);
		parts.push(h, mac);
		len += 24;
	}
	if (fingerprint) {
		header.writeUInt16BE(len + 8, 2);
		const crc = (crc32(Buffer.concat([header, ...parts])) ^ 0x5354554e) >>> 0;
		const h = Buffer.alloc(4);
		h.writeUInt16BE(ATTR.FINGERPRINT, 0);
		h.writeUInt16BE(4, 2);
		parts.push(h, u32(crc));
		len += 8;
	}
	header.writeUInt16BE(len, 2);
	return Buffer.concat([header, ...parts]);
}

function checkIntegrity(msg, key) {
	if (msg.miOffset < 0) return false;
	const raw = msg.raw;
	const mac = raw.subarray(msg.miOffset + 4, msg.miOffset + 24);
	if (mac.length !== 20) return false;
	const header = Buffer.from(raw.subarray(0, 20));
	header.writeUInt16BE(msg.miOffset + 24 - 20, 2);
	const expect = crypto.createHmac("sha1", key).update(header).update(raw.subarray(20, msg.miOffset)).digest();
	return crypto.timingSafeEqual(expect, mac);
}

function longTermKey(username, realm, password) {
	return crypto.createHash("md5").update(`${username}:${realm}:${password}`, "utf8").digest();
}

/**
 * 生成 TURN REST API 临时凭据（与 coturn use-auth-secret 兼容）
 * username = "<过期时间戳>:<用户标识>", credential = base64(HMAC-SHA1(secret, username))
 */
function createTurnCredential(secret, ttlSeconds = 86400, user = "ps") {
	const expiry = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds | 0);
	const username = `${expiry}:${String(user).replace(/:/g, "_")}`;
	const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
	return { username, credential, expiry };
}

/* ------------------------------------------------- ICE 配置生成（多服务器） */

const PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16"];
/** 判断是否内网地址（IPv4 私网/环回/CGNAT/链路本地，IPv6 环回/ULA/链路本地），extra 为额外的内网网段 */
function isPrivateIp(ip, extra = []) {
	const a = normalizeIp(ip);
	if (net.isIPv6(a)) return a === "::1" || /^f[cd]/i.test(a) || /^fe80:/i.test(a);
	return cidrMatcher([...PRIVATE_NETS, ...extra])(a);
}

/**
 * 从请求头取出浏览器"实际访问"的主机与端口（经 nginx 时为 Host/X-Forwarded-Host，原样包含映射后的外网端口）
 * 返回 { host, port, secure }；host 非法时返回 null
 */
function resolveRequestHost(headers = {}, encrypted = false) {
	const proto = String(headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
	const secure = proto ? proto === "https" || proto === "wss" : !!encrypted;
	const raw = String(headers["x-forwarded-host"] || headers.host || "").split(",")[0].trim();
	let host;
	let port;
	const v6 = raw.match(/^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/);
	if (v6) {
		host = `[${v6[1]}]`;
		port = v6[2];
	} else {
		const m = raw.match(/^([A-Za-z0-9.-]+)(?::(\d+))?$/);
		if (!m) return null;
		host = m[1];
		port = m[2];
	}
	if (!port) port = String(headers["x-forwarded-port"] || "").trim() || (secure ? "443" : "80");
	if (!/^\d{1,5}$/.test(port) || +port > 65535) return null;
	return { host, port: +port, secure };
}

const HOST_TOKEN = /\{(host|port)\}/;

/**
 * 根据 servers 配置为某个客户端生成 iceServers。
 *   server: { urls, secret? | username/credential?, scope: "player"|"ue"|"all", audience: "all"|"external"|"lan",
 *             ttl?, ueTtl?, enable? }
 *   ctx:    { scope: "player"|"ue", external: bool, host, port, secure, user, ttl, ueTtl }
 * urls 中的 {host}/{port} 用 ctx 替换（ctx 无 host 时这些 url 被跳过）；
 * turns: 只在 https 访问且 host 是域名时下发（IP 访问时浏览器无法校验证书）。
 */
function buildIceServers(servers = [], ctx = {}) {
	const out = [];
	const isUe = ctx.scope === "ue";
	for (const s of [].concat(servers || [])) {
		if (!s || s.enable === false || !s.urls) continue;
		const scope = s.scope || "player";
		if (isUe ? scope === "player" : scope === "ue") continue;
		const audience = s.audience || "all";
		if (!isUe && audience !== "all" && (audience === "external") !== !!ctx.external) continue;
		const urls = [];
		for (const u of [].concat(s.urls)) {
			if (typeof u !== "string" || !u) continue;
			if (!HOST_TOKEN.test(u)) {
				urls.push(u);
				continue;
			}
			if (!ctx.host) continue;
			if (/^turns:/i.test(u) && (!ctx.secure || net.isIP(ctx.host.replace(/^\[|\]$/g, "")))) continue;
			urls.push(u.replace(/\{host\}/g, ctx.host).replace(/\{port\}/g, String(ctx.port)));
		}
		if (!urls.length) continue;
		const entry = { urls };
		if (s.secret) {
			const ttl = isUe ? s.ueTtl || ctx.ueTtl || 30 * 86400 : s.ttl || ctx.ttl || 86400;
			const c = createTurnCredential(s.secret, ttl, ctx.user || (isUe ? "ue" : "ps"));
			entry.username = c.username;
			entry.credential = c.credential;
		} else if (s.username) {
			entry.username = s.username;
			entry.credential = s.credential;
		}
		out.push(entry);
	}
	return out;
}

/** 兼容旧写法：{ urls, secret, users } → servers 数组 */
function normalizeServers(conf = {}) {
	if (Array.isArray(conf.servers)) return conf.servers;
	const urls = [].concat(conf.urls || []).filter(Boolean);
	if (!urls.length) return [];
	const s = { urls, scope: "player" };
	if (conf.secret) s.secret = conf.secret;
	else if (conf.users && Object.keys(conf.users).length) [s.username, s.credential] = Object.entries(conf.users)[0];
	else if (conf.username) [s.username, s.credential] = [conf.username, conf.credential];
	return [s];
}

/** 生成下发给浏览器的 ICE 配置（ICE API / 旧接口使用） */
function createIceConfig({ iceTransportPolicy, ...conf } = {}, ctx = {}) {
	const cfg = { iceServers: buildIceServers(normalizeServers(conf), { scope: "player", ttl: conf.ttl, ...ctx }) };
	if (iceTransportPolicy) cfg.iceTransportPolicy = iceTransportPolicy;
	return cfg;
}

/* ------------------------------------------------------------- server */

class Allocation {
	constructor(conn, username, socket, port, lifetime) {
		this.conn = conn;
		this.username = username;
		this.socket = socket;
		this.port = port;
		this.expires = Date.now() + lifetime * 1000;
		this.permissions = new Map(); // ip -> expires
		this.channels = new Map(); // number -> { address, port, expires }
		this.peerChannels = new Map(); // "ip:port" -> number
		this.lastIp = null; // onPeerData 查找缓存
		this.lastPort = -1;
		this.lastNum = undefined;
		this.bytesToPeer = 0;
		this.bytesFromPeer = 0;
		this.rate = 0; // 下行码率 EWMA（字节/秒）
		this.rateMark = 0;
		this.queueLimit = 1 << 20; // 首个统计周期前使用硬上限
		this.dropped = 0;
		this.created = Date.now();
	}
}

class TurnServer extends EventEmitter {
	constructor(options = {}) {
		super();
		this.opts = { ...DEFAULTS, ...options };
		const o = this.opts;
		this.log = o.log || console;
		this.relayIp = !o.relayIp || o.relayIp === "auto" ? firstLanIPv4() : o.relayIp;
		this.advertiseIp = o.externalIp || this.relayIp;
		this.isAllowedPeer = cidrMatcher(o.allowedPeers);
		this.isDeniedPeer = cidrMatcher(o.deniedPeers);
		this.isTrustedProxy = (ip) => (o.trustedProxies || []).map(normalizeIp).includes(normalizeIp(ip));
		this.nonceKey = crypto.randomBytes(16);
		this.servers = [];
		this.conns = new Set();
		this.allocations = new Set();
		this.userCounts = new Map();
		this.usedPorts = new Set();
		this.now = Date.now(); // 粗粒度时钟，避免每个包调用 Date.now()
		this.totals = { up: 0, down: 0, dropped: 0, allocations: 0 };
	}

	async start() {
		const o = this.opts;
		const listen = (srv, spec) =>
			new Promise((res, rej) => {
				const { host, port } = parseHostPort(spec);
				srv.once("error", rej);
				srv.listen(port, host, () => {
					srv.off("error", rej);
					srv.on("error", (e) => this.log.error("[turn] server error", e));
					res(srv.address());
				});
			});
		for (const spec of [].concat(o.listen || [])) {
			const srv = net.createServer({ noDelay: true }, (s) => this.handleSocket(s));
			const addr = await listen(srv, spec);
			this.servers.push(srv);
			this.log.info(`[turn] TCP listening ${addr.address}:${addr.port}`);
		}
		if (o.tls && o.tls.cert && o.tls.key) {
			const ctx = { cert: fs.readFileSync(o.tls.cert), key: fs.readFileSync(o.tls.key) };
			for (const spec of [].concat(o.tls.listen || ["0.0.0.0:5349"])) {
				const srv = tls.createServer(ctx, (s) => this.handleSocket(s));
				srv.on("tlsClientError", () => {});
				const addr = await listen(srv, spec);
				this.servers.push(srv);
				this.log.info(`[turn] TLS listening ${addr.address}:${addr.port}`);
			}
		}
		if (!o.secret && !Object.keys(o.users || {}).length) this.log.warn("[turn] 未配置 secret/users，所有 Allocate 都将被拒绝");
		this.log.info(`[turn] relay ${this.relayIp} (advertise ${this.advertiseIp}) ports ${o.minPort}-${o.maxPort}`);
		this.sweeper = setInterval(() => this.sweep(), 10 * 1000);
		this.sweeper.unref?.();
		this.clock = setInterval(() => (this.now = Date.now()), 250);
		this.clock.unref?.();
		this.rater = setInterval(() => this.updateRates(), 1000);
		this.rater.unref?.();
		return this;
	}

	async stop() {
		clearInterval(this.sweeper);
		clearInterval(this.clock);
		clearInterval(this.rater);
		for (const a of [...this.allocations]) this.freeAllocation(a, "shutdown");
		for (const c of [...this.conns]) c.sock.destroy();
		await Promise.all(this.servers.map((s) => new Promise((r) => s.close(() => r()))));
		this.servers = [];
	}

	stats() {
		return {
			connections: this.conns.size,
			allocations: this.allocations.size,
			relayIp: this.relayIp,
			advertiseIp: this.advertiseIp,
			bytesUp: this.totals.up,
			bytesDown: this.totals.down,
			dropped: this.totals.dropped,
			allocationsTotal: this.totals.allocations,
		};
	}

	/* ------------------------------------------------ connection framing */

	handleSocket(sock) {
		const conn = {
			sock,
			buf: null,
			alloc: null,
			allocating: false,
			first: true,
			remote: { address: normalizeIp(sock.remoteAddress), port: sock.remotePort },
			peer: normalizeIp(sock.remoteAddress),
		};
		this.conns.add(conn);
		sock.setNoDelay?.(true);
		sock.setKeepAlive?.(true, 30 * 1000);
		conn.idleTimer = setTimeout(() => {
			if (!conn.alloc) sock.destroy();
		}, this.opts.idleTimeout * 1000);
		sock.on("data", (chunk) => {
			try {
				this.onData(conn, chunk);
			} catch (e) {
				this.log.error("[turn] onData error", e);
				sock.destroy();
			}
		});
		sock.on("error", () => {});
		sock.on("close", () => {
			clearTimeout(conn.idleTimer);
			this.conns.delete(conn);
			if (conn.alloc) this.freeAllocation(conn.alloc, "tcp closed");
		});
	}

	onData(conn, chunk) {
		conn.buf = conn.buf && conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
		if (conn.first) {
			if (!this.consumeProxyHeader(conn)) return;
			conn.first = false;
			conn.sniff = !!this.opts.httpFallback;
		}
		if (conn.sniff) {
			// TURN 连接的第一条消息必然是 STUN（首字节 0x00/0x01）；HTTP 以大写 ASCII 方法名开头
			const b = conn.buf;
			if (!b || !b.length) return;
			if (b[0] >= 0x41 && b[0] <= 0x5a) {
				const head = b.subarray(0, 8).toString("latin1");
				if (/^[A-Z]{3,7} /.test(head)) return this.handoffHttp(conn);
				if (b.length < 8 && /^[A-Z]+$/.test(head)) return; // 方法名还没收全
			}
			conn.sniff = false;
		}
		let buf = conn.buf;
		while (buf.length >= 4) {
			const kind = buf[0] & 0xc0;
			let total;
			if (kind === 0x00) {
				if (buf.length >= 8 && buf.readUInt32BE(4) !== MAGIC) {
					this.debug(`[turn] non-STUN data from ${conn.remote.address}, closing`);
					conn.sock.destroy();
					return;
				}
				if (buf.length < 20) break;
				total = 20 + buf.readUInt16BE(2);
			} else if (kind === 0x40 && conn.alloc) {
				total = 4 + ((buf.readUInt16BE(2) + 3) & ~3); // TCP 上 ChannelData 必须 4 字节对齐
			} else {
				this.debug(`[turn] invalid frame from ${conn.remote.address}, closing`);
				conn.sock.destroy();
				return;
			}
			if (buf.length < total) break;
			const frame = buf.subarray(0, total);
			buf = buf.subarray(total);
			if (kind === 0x00) this.onStun(conn, frame);
			else this.onChannelData(conn, frame);
			if (conn.sock.destroyed) return;
		}
		conn.buf = buf.length ? buf : null;
		if (buf.length > 70 * 1024) conn.sock.destroy();
	}

	/** 把识别为 HTTP 的连接原样转交给 httpFallback（带 PROXY v1 头，保留真实客户端地址） */
	handoffHttp(conn) {
		const sock = conn.sock;
		clearTimeout(conn.idleTimer);
		this.conns.delete(conn);
		sock.removeAllListeners("data");
		const m = String(this.opts.httpFallback).match(/^\[?([^\]]+?)\]?:(\d+)$/);
		if (!m) return sock.destroy();
		const up = net.connect({ host: m[1], port: +m[2] });
		up.setNoDelay(true);
		const src = conn.remote.address || "127.0.0.1";
		const v6 = net.isIPv6(src);
		let dst = normalizeIp(sock.localAddress) || "127.0.0.1";
		if (v6 && !net.isIPv6(dst)) dst = `::ffff:${dst}`;
		if (!v6 && net.isIPv6(dst)) dst = "127.0.0.1";
		up.write(`PROXY ${v6 ? "TCP6" : "TCP4"} ${src} ${dst} ${conn.remote.port || 0} ${sock.localPort || 0}\r\n`);
		if (conn.buf && conn.buf.length) up.write(conn.buf);
		conn.buf = null;
		sock.pipe(up);
		up.pipe(sock);
		const close = () => {
			sock.destroy();
			up.destroy();
		};
		up.on("error", close);
		up.on("close", close);
		sock.on("close", close);
		this.totals.http = (this.totals.http || 0) + 1;
	}

	/** 解析 PROXY protocol v1（nginx stream `proxy_protocol on;`）。返回 false 表示还需要更多数据 */
	consumeProxyHeader(conn) {
		if (!this.opts.proxyProtocol || !this.isTrustedProxy(conn.peer)) return true;
		const buf = conn.buf;
		const sig = "PROXY ";
		const head = buf.subarray(0, Math.min(buf.length, 6)).toString("latin1");
		if (!sig.startsWith(head)) return true; // 不是 PROXY 头
		if (buf.length < 6) return false;
		const end = buf.indexOf("\r\n");
		if (end < 0) {
			if (buf.length > 108) conn.sock.destroy();
			return false;
		}
		const parts = buf.subarray(0, end).toString("latin1").split(" ");
		// PROXY TCP4 <src> <dst> <sport> <dport>
		if ((parts[1] === "TCP4" || parts[1] === "TCP6") && parts.length === 6) {
			conn.remote = { address: normalizeIp(parts[2]), port: +parts[4] };
		}
		conn.buf = buf.subarray(end + 2);
		return true;
	}

	/* -------------------------------------------------------- STUN/TURN */

	send(conn, buf) {
		if (!conn.sock.destroyed && conn.sock.writable) conn.sock.write(buf);
	}

	reply(conn, msg, cls, attrs, key) {
		const all = attrs.slice();
		all.push(attr(ATTR.SOFTWARE, SOFTWARE));
		this.send(conn, buildStun(msg.method, cls, msg.tid, all, key, msg.hasFingerprint));
	}

	replyError(conn, msg, code, key, extra = []) {
		this.debug(`[turn] ${conn.remote.address} method=0x${msg.method.toString(16)} -> ${code}`);
		this.reply(conn, msg, CLASS.ERROR, [attr(ATTR.ERROR_CODE, errorCodeValue(code)), ...extra], key);
	}

	makeNonce() {
		const exp = Math.floor(Date.now() / 1000) + this.opts.nonceTtl;
		const e = exp.toString(16).padStart(8, "0");
		return e + crypto.createHmac("sha1", this.nonceKey).update(e).digest("hex").slice(0, 24);
	}

	nonceValid(n) {
		if (typeof n !== "string" || n.length !== 32) return false;
		const e = n.slice(0, 8);
		const mac = crypto.createHmac("sha1", this.nonceKey).update(e).digest("hex").slice(0, 24);
		if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(n.slice(8)))) return false;
		return parseInt(e, 16) > Date.now() / 1000;
	}

	lookupPassword(username) {
		const o = this.opts;
		if (o.users && Object.prototype.hasOwnProperty.call(o.users, username)) return String(o.users[username]);
		if (o.secret) {
			// TURN REST API: 用户名中任意一段纯数字视为过期时间戳
			const ts = username.split(":").find((p) => /^\d{9,11}$/.test(p));
			if (!ts || +ts < Date.now() / 1000) return null;
			return crypto.createHmac("sha1", o.secret).update(username).digest("base64");
		}
		return null;
	}

	authenticate(conn, msg) {
		const realmAttrs = () => [attr(ATTR.REALM, this.opts.realm), attr(ATTR.NONCE, this.makeNonce())];
		const mi = msg.attrs.get(ATTR.MESSAGE_INTEGRITY);
		const u = msg.attrs.get(ATTR.USERNAME);
		if (!mi || !u) return this.replyError(conn, msg, 401, null, realmAttrs());
		const realm = msg.attrs.get(ATTR.REALM)?.toString("utf8");
		const nonce = msg.attrs.get(ATTR.NONCE)?.toString("utf8");
		if (!realm || !nonce) return this.replyError(conn, msg, 400);
		if (!this.nonceValid(nonce)) return this.replyError(conn, msg, 438, null, realmAttrs());
		const username = u.toString("utf8");
		const password = this.lookupPassword(username);
		if (password === null || realm !== this.opts.realm) return this.replyError(conn, msg, 401, null, realmAttrs());
		const key = longTermKey(username, realm, password);
		if (!checkIntegrity(msg, key)) return this.replyError(conn, msg, 401, null, realmAttrs());
		if (conn.alloc && conn.alloc.username !== username) return this.replyError(conn, msg, 441, key);
		return { username, key };
	}

	onStun(conn, frame) {
		const msg = parseStun(frame);
		if (!msg) return;
		if (msg.cls === CLASS.INDICATION) {
			if (msg.method === METHOD.SEND) this.onSendIndication(conn, msg);
			return;
		}
		if (msg.cls !== CLASS.REQUEST) return;
		if (msg.method === METHOD.BINDING) {
			return this.reply(conn, msg, CLASS.SUCCESS, [
				attr(ATTR.XOR_MAPPED_ADDRESS, encodeXorAddress(conn.remote.address, conn.remote.port, msg.tid)),
			]);
		}
		if (![METHOD.ALLOCATE, METHOD.REFRESH, METHOD.CREATE_PERMISSION, METHOD.CHANNEL_BIND].includes(msg.method)) {
			return this.replyError(conn, msg, 400);
		}
		const auth = this.authenticate(conn, msg);
		if (!auth) return;
		switch (msg.method) {
			case METHOD.ALLOCATE:
				return this.onAllocate(conn, msg, auth);
			case METHOD.REFRESH:
				return this.onRefresh(conn, msg, auth);
			case METHOD.CREATE_PERMISSION:
				return this.onCreatePermission(conn, msg, auth);
			case METHOD.CHANNEL_BIND:
				return this.onChannelBind(conn, msg, auth);
		}
	}

	clampLifetime(msg) {
		const o = this.opts;
		const v = msg.attrs.get(ATTR.LIFETIME);
		const req = v && v.length >= 4 ? v.readUInt32BE(0) : o.defaultLifetime;
		return Math.min(Math.max(req, o.defaultLifetime), o.maxLifetime);
	}

	async onAllocate(conn, msg, { username, key }) {
		const o = this.opts;
		if (conn.alloc || conn.allocating) return this.replyError(conn, msg, 437, key);
		const rt = msg.attrs.get(ATTR.REQUESTED_TRANSPORT);
		if (!rt || rt.length < 1) return this.replyError(conn, msg, 400, key);
		if (rt[0] !== 17) return this.replyError(conn, msg, 442, key);
		const fam = msg.attrs.get(ATTR.REQUESTED_ADDRESS_FAMILY);
		if (fam && fam[0] !== 0x01) return this.replyError(conn, msg, 440, key);
		if (msg.attrs.get(ATTR.RESERVATION_TOKEN)) return this.replyError(conn, msg, 508, key);
		if (this.allocations.size >= o.maxAllocations) return this.replyError(conn, msg, 486, key);
		if ((this.userCounts.get(username) || 0) >= o.maxAllocationsPerUser) return this.replyError(conn, msg, 486, key);

		const lifetime = this.clampLifetime(msg);
		conn.allocating = true;
		let bound;
		try {
			bound = await this.bindRelaySocket();
		} catch (e) {
			conn.allocating = false;
			this.log.error("[turn] relay bind failed:", e.message);
			return this.replyError(conn, msg, 508, key);
		}
		conn.allocating = false;
		if (conn.sock.destroyed) {
			this.releasePort(bound.port);
			bound.socket.close();
			return;
		}
		const alloc = new Allocation(conn, username, bound.socket, bound.port, lifetime);
		conn.alloc = alloc;
		clearTimeout(conn.idleTimer);
		this.allocations.add(alloc);
		this.totals.allocations++;
		this.userCounts.set(username, (this.userCounts.get(username) || 0) + 1);
		bound.socket.on("message", (data, rinfo) => this.onPeerData(alloc, data, rinfo));
		bound.socket.on("error", (e) => this.debug("[turn] relay socket error", e.message));
		this.log.info(`[turn] allocate ${conn.remote.address}:${conn.remote.port} user=${username} relay=${this.advertiseIp}:${bound.port} life=${lifetime}s`);
		this.emit("allocate", { remote: conn.remote, username, port: bound.port });
		this.reply(
			conn,
			msg,
			CLASS.SUCCESS,
			[
				attr(ATTR.XOR_RELAYED_ADDRESS, encodeXorAddress(this.advertiseIp, bound.port, msg.tid)),
				attr(ATTR.LIFETIME, u32(lifetime)),
				attr(ATTR.XOR_MAPPED_ADDRESS, encodeXorAddress(conn.remote.address, conn.remote.port, msg.tid)),
			],
			key
		);
	}

	releasePort(port) {
		this.usedPorts.delete(port);
	}

	bindRelaySocket() {
		const { minPort, maxPort } = this.opts;
		const range = minPort && maxPort && maxPort >= minPort ? maxPort - minPort + 1 : 0;
		const tryBind = (port) =>
			new Promise((res, rej) => {
				const s = dgram.createSocket({ type: "udp4" });
				s.once("error", (e) => {
					s.close();
					rej(e);
				});
				s.bind({ port, address: this.relayIp, exclusive: true }, () => {
					s.removeAllListeners("error");
					// 关键帧是成百上千个包的突发，默认的 UDP 接收缓冲（Windows 64KB / Linux ~208KB）会直接溢出丢包
					try {
						s.setRecvBufferSize(this.opts.udpRecvBuffer);
					} catch {}
					try {
						s.setSendBufferSize(this.opts.udpSendBuffer);
					} catch {}
					res({ socket: s, port: s.address().port });
				});
			});
		return (async () => {
			if (!range) return tryBind(0);
			const start = Math.floor(Math.random() * range);
			for (let i = 0; i < range; i++) {
				const port = minPort + ((start + i) % range);
				if (this.usedPorts.has(port)) continue;
				this.usedPorts.add(port);
				try {
					return await tryBind(port);
				} catch (e) {
					this.usedPorts.delete(port);
					if (e.code !== "EADDRINUSE" && e.code !== "EACCES") throw e;
				}
			}
			throw new Error(`no free relay port in ${minPort}-${maxPort}`);
		})();
	}

	onRefresh(conn, msg, { key }) {
		const alloc = conn.alloc;
		if (!alloc) return this.replyError(conn, msg, 437, key);
		const v = msg.attrs.get(ATTR.LIFETIME);
		const req = v && v.length >= 4 ? v.readUInt32BE(0) : this.opts.defaultLifetime;
		if (req === 0) {
			this.reply(conn, msg, CLASS.SUCCESS, [attr(ATTR.LIFETIME, u32(0))], key);
			this.freeAllocation(alloc, "refresh 0");
			return;
		}
		const lifetime = this.clampLifetime(msg);
		alloc.expires = Date.now() + lifetime * 1000;
		this.reply(conn, msg, CLASS.SUCCESS, [attr(ATTR.LIFETIME, u32(lifetime))], key);
	}

	peerAllowed(peer) {
		if (!peer || peer.family !== 4) return false;
		const [pmin, pmax] = this.opts.allowedPeerPorts || [1, 65535];
		if (peer.port < pmin || peer.port > pmax) return false;
		if (this.isDeniedPeer(peer.address)) return false;
		return this.isAllowedPeer(peer.address);
	}

	onCreatePermission(conn, msg, { key }) {
		const alloc = conn.alloc;
		if (!alloc) return this.replyError(conn, msg, 437, key);
		const values = [msg.attrs.get(ATTR.XOR_PEER_ADDRESS), ...(msg.extraPeers || [])].filter(Boolean);
		if (!values.length) return this.replyError(conn, msg, 400, key);
		const peers = values.map((v) => decodeXorAddress(v, msg.tid));
		if (peers.some((p) => !p)) return this.replyError(conn, msg, 400, key);
		if (peers.some((p) => p.family !== 4)) return this.replyError(conn, msg, 440, key);
		// 权限只看 IP；端口在真正转发时再校验
		if (peers.some((p) => !this.peerAllowed({ ...p, port: this.opts.allowedPeerPorts?.[0] || 1 }))) {
			this.debug(`[turn] permission denied ${peers.map((p) => p.address).join(",")}`);
			return this.replyError(conn, msg, 403, key);
		}
		const exp = Date.now() + 300 * 1000;
		for (const p of peers) alloc.permissions.set(p.address, exp);
		this.reply(conn, msg, CLASS.SUCCESS, [], key);
	}

	onChannelBind(conn, msg, { key }) {
		const alloc = conn.alloc;
		if (!alloc) return this.replyError(conn, msg, 437, key);
		const cn = msg.attrs.get(ATTR.CHANNEL_NUMBER);
		const peer = decodeXorAddress(msg.attrs.get(ATTR.XOR_PEER_ADDRESS), msg.tid);
		if (!cn || cn.length < 4 || !peer) return this.replyError(conn, msg, 400, key);
		const num = cn.readUInt16BE(0);
		if (num < 0x4000 || num > 0x7ffe) return this.replyError(conn, msg, 400, key);
		if (peer.family !== 4) return this.replyError(conn, msg, 440, key);
		if (!this.peerAllowed(peer)) return this.replyError(conn, msg, 403, key);
		const pk = `${peer.address}:${peer.port}`;
		const existing = alloc.channels.get(num);
		if (existing && `${existing.address}:${existing.port}` !== pk) return this.replyError(conn, msg, 400, key);
		const existingNum = alloc.peerChannels.get(pk);
		if (existingNum !== undefined && existingNum !== num) return this.replyError(conn, msg, 400, key);
		const now = Date.now();
		alloc.channels.set(num, { address: peer.address, port: peer.port, expires: now + 600 * 1000 });
		alloc.peerChannels.set(pk, num);
		alloc.lastPort = -1; // 通道表变化，清空 onPeerData 的查找缓存
		alloc.permissions.set(peer.address, now + 300 * 1000);
		this.reply(conn, msg, CLASS.SUCCESS, [], key);
	}

	hasPermission(alloc, ip) {
		const exp = alloc.permissions.get(ip);
		return exp !== undefined && exp > this.now;
	}

	onSendIndication(conn, msg) {
		const alloc = conn.alloc;
		if (!alloc) return;
		const peer = decodeXorAddress(msg.attrs.get(ATTR.XOR_PEER_ADDRESS), msg.tid);
		const data = msg.attrs.get(ATTR.DATA);
		if (!peer || !data || !this.hasPermission(alloc, peer.address) || !this.peerAllowed(peer)) return;
		alloc.bytesToPeer += data.length;
		this.totals.up += data.length;
		alloc.socket.send(data, peer.port, peer.address);
	}

	onChannelData(conn, frame) {
		const alloc = conn.alloc;
		if (!alloc) return;
		const num = frame.readUInt16BE(0);
		const len = frame.readUInt16BE(2);
		const ch = alloc.channels.get(num);
		if (!ch || ch.expires < this.now || !this.hasPermission(alloc, ch.address)) return;
		alloc.bytesToPeer += len;
		this.totals.up += len;
		alloc.socket.send(frame.subarray(4, 4 + len), ch.port, ch.address);
	}

	/**
	 * 批量发送：同一轮事件循环里发往同一连接的多个中继包先攒在 conn.outList，
	 * 在 setImmediate（check 阶段，即本轮 poll 处理完所有就绪数据报之后）合并成一次 write。
	 * Node 流的每次 write() 开销远大于拷贝 1.2KB，合并后单包 CPU 开销下降数倍、系统调用降一个数量级。
	 */
	enqueue(conn, bufs, total) {
		if (!conn.outList) {
			conn.outList = [];
			conn.outLen = 0;
			if (!this.flushSet) {
				this.flushSet = new Set();
				setImmediate(() => {
					const set = this.flushSet;
					this.flushSet = null;
					for (const c of set) this.flush(c);
				});
			}
			this.flushSet.add(conn);
		}
		for (const b of bufs) conn.outList.push(b);
		conn.outLen += total;
		if (conn.outLen >= 256 * 1024) this.flush(conn); // 突发很大时提前刷出，限制单次拷贝量
	}

	flush(conn) {
		const list = conn.outList;
		if (!list) return;
		const len = conn.outLen;
		conn.outList = null;
		conn.outLen = 0;
		if (conn.sock.destroyed || !len) return;
		conn.sock.write(list.length === 1 ? list[0] : Buffer.concat(list, len));
	}

	onPeerData(alloc, data, rinfo) {
		const ip = rinfo.address; // udp4 套接字，地址一定是点分 IPv4，无需再规范化
		if (!this.hasPermission(alloc, ip)) return;
		const conn = alloc.conn;
		const sock = conn.sock;
		if (sock.destroyed) return;
		if (sock.writableLength + (conn.outLen || 0) > alloc.queueLimit) {
			alloc.dropped++; // TCP 拥塞：像 UDP 一样丢包，交给 WebRTC 的 NACK/PLI 处理，避免延迟堆积
			this.totals.dropped++;
			return;
		}
		const len = data.length;
		alloc.bytesFromPeer += len;
		this.totals.down += len;
		// UE 的视频几乎总是来自同一个 ip:port，缓存上一次的通道查找结果
		let num;
		if (alloc.lastPort === rinfo.port && alloc.lastIp === ip) num = alloc.lastNum;
		else {
			num = alloc.peerChannels.get(ip + ":" + rinfo.port);
			alloc.lastIp = ip;
			alloc.lastPort = rinfo.port;
			alloc.lastNum = num;
		}
		const ch = num !== undefined ? alloc.channels.get(num) : null;
		if (ch && ch.expires > this.now) {
			const pad = (4 - (len % 4)) % 4;
			const head = Buffer.allocUnsafe(4); // 小于 4KB 的 allocUnsafe 走内存池，几乎无开销
			head.writeUInt16BE(num, 0);
			head.writeUInt16BE(len, 2);
			if (pad) this.enqueue(conn, [head, data, PADDING[pad]], 4 + len + pad);
			else this.enqueue(conn, [head, data], 4 + len);
			return;
		}
		const tid = crypto.randomBytes(12);
		const ind = buildStun(METHOD.DATA, CLASS.INDICATION, tid, [
			attr(ATTR.XOR_PEER_ADDRESS, encodeXorAddress(ip, rinfo.port, tid)),
			attr(ATTR.DATA, data),
		]);
		this.enqueue(conn, [ind], ind.length);
	}

	freeAllocation(alloc, reason) {
		if (!this.allocations.has(alloc)) return;
		this.allocations.delete(alloc);
		const n = (this.userCounts.get(alloc.username) || 1) - 1;
		if (n > 0) this.userCounts.set(alloc.username, n);
		else this.userCounts.delete(alloc.username);
		try {
			alloc.socket.close();
		} catch {}
		this.releasePort(alloc.port);
		if (alloc.conn.alloc === alloc) alloc.conn.alloc = null;
		const secs = ((Date.now() - alloc.created) / 1000).toFixed(0);
		this.log.info(
			`[turn] free relay=${alloc.port} user=${alloc.username} reason=${reason} up=${alloc.bytesToPeer}B down=${alloc.bytesFromPeer}B dropped=${alloc.dropped} ${secs}s`
		);
		this.emit("free", { username: alloc.username, port: alloc.port, reason });
		if (reason !== "tcp closed" && reason !== "refresh 0") alloc.conn.sock.end();
	}

	/** 按实测下行码率（EWMA）计算每个连接允许积压的字节数 */
	updateRates() {
		const { maxQueueMs, minQueueBytes, maxBufferedBytes } = this.opts;
		for (const a of this.allocations) {
			const delta = a.bytesFromPeer - a.rateMark;
			a.rateMark = a.bytesFromPeer;
			a.rate = a.rate ? a.rate * 0.7 + delta * 0.3 : delta; // 字节/秒
			a.queueLimit = Math.min(maxBufferedBytes, Math.max(minQueueBytes, (a.rate * maxQueueMs) / 1000));
		}
	}

	sweep() {
		const now = Date.now();
		for (const a of [...this.allocations]) {
			if (a.expires < now) {
				this.freeAllocation(a, "expired");
				continue;
			}
			for (const [ip, exp] of a.permissions) if (exp < now) a.permissions.delete(ip);
			for (const [num, ch] of a.channels) {
				if (ch.expires < now) {
					a.channels.delete(num);
					a.peerChannels.delete(`${ch.address}:${ch.port}`);
					a.lastPort = -1;
				}
			}
		}
	}

	debug(...args) {
		if (this.opts.debug) this.log.info(...args);
	}
}

/* ------------------------------------------------------- standalone */

/** 取真实客户端 IP（只信任来自 trustProxy 的 X-Real-IP / X-Forwarded-For） */
function requestClientIp(req, trustProxy = ["127.0.0.1", "::1"]) {
	const peer = normalizeIp(req.socket.remoteAddress);
	if (!trustProxy.map(normalizeIp).includes(peer)) return peer;
	const xri = req.headers["x-real-ip"];
	if (xri) return normalizeIp(String(xri).trim());
	const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((v) => v.trim()).filter(Boolean);
	return xff.length ? normalizeIp(xff[xff.length - 1]) : peer;
}

/**
 * ICE 配置接口：GET /ice → { iceServers, iceTransportPolicy }
 * 主要给闭源的 PeerStreamEnterprise 使用（其 signal.js 只能下发静态 iceServers）。
 * 经 nginx 暴露为 /__ice，前端 <video is="peer-stream" ice-config="/__ice"> 即可使用。
 *   conf.servers               同 signal.json turn.servers（支持 {host}/{port}）
 *   conf.iceTransportPolicy    "all" | "relay" | "external"（外网客户端强制 relay）
 */
function startIceApi(conf, log = console) {
	const { host, port } = parseHostPort(conf.listen || "127.0.0.1:3480", "127.0.0.1");
	// 未单独配置凭据的 turn:/turns: 条目视为指向本 TURN，沿用本 TURN 的 secret（STUN 条目不需要凭据）
	const servers = normalizeServers(conf).map((s) =>
		conf.secret && !s.secret && !s.username && [].concat(s.urls || []).some((u) => /^turns?:/i.test(u)) ? { ...s, secret: conf.secret } : s
	);
	const trust = conf.trustProxy || ["127.0.0.1", "::1"];
	const srv = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (req.method !== "GET" || !/\/(__)?ice\/?$/.test(url.pathname)) {
			res.writeHead(404).end();
			return;
		}
		const ip = requestClientIp(req, trust);
		const external = !isPrivateIp(ip, conf.lanNetworks || []);
		const proxied = trust.map(normalizeIp).includes(normalizeIp(req.socket.remoteAddress));
		const where = proxied ? resolveRequestHost(req.headers) : null;
		const iceServers = buildIceServers(servers, {
			scope: "player",
			external,
			...(where || {}),
			ttl: conf.ttl,
			user: ip.replace(/[^0-9a-fA-F.]/g, "_"),
		});
		const p = conf.iceTransportPolicy || "all";
		const policy = p === "relay" || (p === "external" && external) ? "relay" : "all";
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ iceServers, iceTransportPolicy: policy }));
	});
	srv.on("error", (e) => log.error("[turn] ICE API error:", e.message));
	srv.listen(port, host, () => log.info(`[turn] ICE config API on http://${host}:${port}/ice`));
	return srv;
}

function loadConfig(file) {
	let conf = {};
	if (process.env.TURN_CONFIG_JSON) conf = JSON.parse(process.env.TURN_CONFIG_JSON);
	else if (file && fs.existsSync(file)) conf = JSON.parse(fs.readFileSync(file, "utf8").replace(/^FEFF/, ""));
	const env = process.env;
	if (env.TURN_SECRET) conf.secret = env.TURN_SECRET;
	if (env.TURN_LISTEN) conf.listen = env.TURN_LISTEN.split(",");
	if (env.TURN_RELAY_IP) conf.relayIp = env.TURN_RELAY_IP;
	if (env.TURN_EXTERNAL_IP) conf.externalIp = env.TURN_EXTERNAL_IP;
	if (env.TURN_MIN_PORT) conf.minPort = +env.TURN_MIN_PORT;
	if (env.TURN_MAX_PORT) conf.maxPort = +env.TURN_MAX_PORT;
	if (env.TURN_ALLOWED_PEERS) conf.allowedPeers = env.TURN_ALLOWED_PEERS.split(",");
	if (env.TURN_WORKERS) conf.workers = env.TURN_WORKERS;
	if (env.TURN_URLS) conf.iceApi = { ...(conf.iceApi || {}), urls: env.TURN_URLS.split(",") };
	return conf;
}

/**
 * 独立运行（可多进程）：workers>1 时主进程只做守护/汇总，worker 进程共享 TCP 监听口各自处理连接。
 * 被 signal.js 以子进程方式拉起时，通过 IPC 每 5 秒上报一次汇总统计。
 */
function runStandalone(conf, log = console) {
	const cluster = require("cluster");
	const cpus = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
	const workers = Math.max(1, conf.workers === "auto" ? Math.min(4, cpus) : +conf.workers || 1);
	const report = (stats) => process.send && process.connected && process.send({ type: "turn-stats", stats });

	if (workers > 1 && cluster.isPrimary) {
		const stats = new Map();
		let stopping = false;
		const fork = () => {
			const w = cluster.fork();
			w.on("message", (m) => m && m.type === "turn-stats" && stats.set(w.id, m.stats));
		};
		for (let i = 0; i < workers; i++) fork();
		cluster.on("exit", (w, code, signal) => {
			stats.delete(w.id);
			if (stopping) return;
			log.error(`[turn] worker ${w.process.pid} exited (${signal || code}), restarting`);
			setTimeout(fork, 1000);
		});
		if (conf.iceApi && (conf.iceApi.urls || conf.iceApi.servers)) startIceApi({ secret: conf.secret, users: conf.users, ...conf.iceApi }, log);
		const timer = setInterval(() => {
			const sum = { workers: stats.size, connections: 0, allocations: 0, bytesUp: 0, bytesDown: 0, dropped: 0, allocationsTotal: 0 };
			for (const st of stats.values()) for (const k of Object.keys(sum)) if (k !== "workers") sum[k] += st[k] || 0;
			const any = stats.values().next().value;
			if (any) Object.assign(sum, { relayIp: any.relayIp, advertiseIp: any.advertiseIp });
			report(sum);
		}, 5000);
		timer.unref();
		const shutdown = () => {
			stopping = true;
			for (const w of Object.values(cluster.workers || {})) w.process.kill("SIGTERM");
			setTimeout(() => process.exit(0), 1500).unref();
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
		process.on("disconnect", shutdown); // 父进程（signal.js）退出时一并退出
		return;
	}

	const server = new TurnServer({ ...conf, log });
	server
		.start()
		.then(() => {
			if (!cluster.isWorker && conf.iceApi && (conf.iceApi.urls || conf.iceApi.servers)) {
				startIceApi({ secret: conf.secret, users: conf.users, ...conf.iceApi }, log);
			}
			const timer = setInterval(() => report({ workers: 1, ...server.stats() }), 5000);
			timer.unref();
		})
		.catch((e) => {
			log.error("[turn] start failed:", e.message);
			process.exit(1);
		});
	const shutdown = () => server.stop().then(() => process.exit(0));
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	if (process.send) process.on("disconnect", shutdown);
}

function main(argv = process.argv) {
	const args = argv.slice(2).filter((a) => a !== "--turn");
	const file = args[0] || process.env.TURN_CONFIG || path.join(__dirname, "turn.json");
	runStandalone(loadConfig(file));
}

if (require.main === module) main();

module.exports = {
	TurnServer,
	createTurnCredential,
	createIceConfig,
	buildIceServers,
	normalizeServers,
	resolveRequestHost,
	isPrivateIp,
	startIceApi,
	loadConfig,
	runStandalone,
	main,
	cidrMatcher,
	normalizeIp,
	// 供测试使用
	_codec: { parseStun, buildStun, encodeXorAddress, decodeXorAddress, checkIntegrity, longTermKey, crc32, METHOD, CLASS, ATTR, MAGIC },
};
