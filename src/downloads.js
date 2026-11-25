"use strict";
/**
 * Agent 安装包：渲染机直接从平台下载，无需另外拷贝发布包。
 *
 *   windows  图形安装程序 ps-platform-agent-setup.exe（agent-setup/ 编译的向导 + 末尾附加 gzip 压缩的 ps-platform.exe）。
 *            平台下载时再在末尾附加一段配置（平台地址与接入令牌），渲染机上双击按「下一步」即可完成安装。
 *   linux    ps-platform 可执行文件（以 --agent 运行）。
 *
 * 来源（按优先级）：
 *   1. <dataDir>/downloads/ 中的文件：管理端上传、一键从发布页获取，或手动放入
 *   2. 平台本身就是打包程序时：Linux 直接提供自身；Windows 用随包附带的安装向导 + 自身生成安装程序（缓存到 downloads/）
 * 发布页地址默认是 GitHub Releases 中与平台同版本的文件，可用 config.downloads.releaseBaseUrl / PS_RELEASE_BASE_URL 改为内网镜像。
 *
 * 附加数据段格式（与 agent-setup/AgentSetup.cs 一致），从文件末尾向前读取：[数据][8 字节长度 LE][8 字节标记]
 *   PSAGENT1  [8 字节原始大小 LE][gzip 压缩的 ps-platform.exe]
 *   PSCONF01  UTF-8 JSON（离末尾最近的生效）
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { once } = require("events");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const AGENT_TAG = "PSAGENT1";
const CONFIG_TAG = "PSCONF01";
const MZ = Buffer.from("MZ");
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

const TARGETS = {
	windows: {
		file: "ps-platform-agent-setup.exe",
		label: "Windows 安装程序",
		magic: MZ,
		kind: "Windows 安装程序（ps-platform-agent-setup-<版本>.exe）",
		asset: (v) => `ps-platform-agent-setup-${v}.exe`,
		validate(file) {
			if (!findSection(file, AGENT_TAG)) throw err(400, "这不是 Agent 安装程序（缺少内置的 Agent 程序）：请上传发布页中的 ps-platform-agent-setup-<版本>.exe，而不是 ps-platform.exe");
		},
	},
	linux: {
		file: "ps-platform",
		label: "Linux x64",
		magic: ELF,
		kind: "Linux 可执行文件（ps-platform）",
		asset: (v) => `ps-platform-agent-${v}-linux-x64`,
	},
};
const MAX_SIZE = 512 * 1048576;
const MIN_SIZE = 1048576; // 打包后的程序远大于 1MB：更小的一定是错误页面或残缺文件
const FETCH_TIMEOUT_MS = 30 * 60 * 1000;
const err = (status, message) => Object.assign(new Error(message), { status });

/* ---------------------------------------------------------------- 数据段 */

function trailer(length, tag) {
	const b = Buffer.alloc(16);
	b.writeBigUInt64LE(BigInt(length), 0);
	b.write(tag, 8, "ascii");
	return b;
}

/** 配置段：附加在安装程序末尾 */
function configSection(obj) {
	const data = Buffer.from(JSON.stringify(obj), "utf8");
	return Buffer.concat([data, trailer(data.length, CONFIG_TAG)]);
}

/** 从末尾向前列出数据段（第一个离末尾最近） */
function readSections(file) {
	const fd = fs.openSync(file, "r");
	try {
		let pos = fs.fstatSync(fd).size;
		const sections = [];
		const b = Buffer.alloc(16);
		while (pos >= 16) {
			fs.readSync(fd, b, 0, 16, pos - 16);
			const len = Number(b.readBigUInt64LE(0));
			const tag = b.toString("ascii", 8, 16);
			if ((tag !== AGENT_TAG && tag !== CONFIG_TAG) || len > pos - 16) break;
			pos = pos - 16 - len;
			sections.push({ tag, offset: pos, length: len });
		}
		return { sections, stubLength: pos };
	} finally {
		fs.closeSync(fd);
	}
}

function findSection(file, tag) {
	try {
		return readSections(file).sections.find((s) => s.tag === tag) || null;
	} catch {
		return null;
	}
}

/** 安装程序中内置的 Agent：{ start, end（含）, size（解压后） } */
function agentPayload(file) {
	const s = findSection(file, AGENT_TAG);
	if (!s || s.length < 9) return null;
	const fd = fs.openSync(file, "r");
	try {
		const b = Buffer.alloc(8);
		fs.readSync(fd, b, 0, 8, s.offset);
		return { start: s.offset + 8, end: s.offset + s.length - 1, size: Number(b.readBigUInt64LE(0)) };
	} finally {
		fs.closeSync(fd);
	}
}

async function writeChunk(out, chunk) {
	if (!out.write(chunk)) await once(out, "drain");
}

class AgentPackages {
	/**
	 * @param {object} o
	 * @param {string} o.dir             保存目录（<dataDir>/downloads）
	 * @param {string} o.version         平台版本（发布页文件名与版本提示）
	 * @param {string|null} o.selfExe    平台自身的可执行文件（仅打包运行时）
	 * @param {string|null} o.setupStub  安装向导程序（不含 Agent，随 Windows 发布包附带）
	 * @param {string} o.releaseBaseUrl  发布页地址模板，{version} 替换为版本号；空 = 不提供一键获取
	 */
	constructor({ dir, version, selfExe = null, setupStub = null, releaseBaseUrl = "", log = console, fetchImpl = globalThis.fetch, minSize = MIN_SIZE, platform = process.platform }) {
		this.dir = dir;
		this.version = version;
		this.selfExe = selfExe;
		this.setupStub = setupStub;
		this.releaseBaseUrl = releaseBaseUrl;
		this.log = log;
		this.fetch = fetchImpl;
		this.minSize = minSize;
		this.platform = platform;
		this.jobs = new Map(); // 目标 → 正在进行 / 最近一次的获取或生成任务
		this.metaFile = path.join(dir, "packages.json");
	}

	target(name) {
		const t = Object.hasOwn(TARGETS, name) && TARGETS[name];
		if (!t) throw err(404, `不支持的安装包：${name}（可选 ${Object.keys(TARGETS).join(" / ")}）`);
		return t;
	}

	baseUrl() {
		return String(this.releaseBaseUrl || "")
			.replace(/\{version\}/g, this.version)
			.replace(/\/+$/, "");
	}

	/** 给人看的发布页（GitHub 的下载目录 → 对应版本的 Release 页面） */
	releasePage() {
		const b = this.baseUrl();
		return b.includes("/releases/download/") ? b.replace("/releases/download/", "/releases/tag/") : b;
	}

	readMeta() {
		try {
			return JSON.parse(fs.readFileSync(this.metaFile, "utf8")) || {};
		} catch {
			return {};
		}
	}

	writeMeta(meta) {
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.metaFile}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
		fs.renameSync(tmp, this.metaFile);
	}

	setMeta(name, entry) {
		const meta = this.readMeta();
		if (entry) meta[name] = entry;
		else delete meta[name];
		this.writeMeta(meta);
	}

	/** 当前可下载的文件：{ path, file, size, mtimeMs, source } 或 null */
	resolve(name) {
		const t = this.target(name);
		const f = path.join(this.dir, t.file);
		try {
			const st = fs.statSync(f);
			if (st.isFile() && st.size > 0) return { path: f, file: t.file, size: st.size, mtimeMs: st.mtimeMs, source: "file" };
		} catch {}
		if (name === "linux" && this.selfExe && this.platform === "linux" && process.arch === "x64") {
			try {
				const st = fs.statSync(this.selfExe);
				return { path: this.selfExe, file: t.file, size: st.size, mtimeMs: st.mtimeMs, source: "self" };
			} catch {}
		}
		return null;
	}

	/** Windows 的 Agent 程序本身（命令行方式使用）：平台自身，或从安装程序中解压。{ path, size, gzip?:{start,end} } */
	resolveWindowsExe() {
		if (this.selfExe && this.platform === "win32") {
			try {
				return { path: this.selfExe, size: fs.statSync(this.selfExe).size };
			} catch {}
		}
		const setup = this.resolve("windows");
		const p = setup && agentPayload(setup.path);
		return p ? { path: setup.path, size: p.size, gzip: { start: p.start, end: p.end } } : null;
	}

	status() {
		const meta = this.readMeta();
		const targets = {};
		for (const [name, t] of Object.entries(TARGETS)) {
			const r = this.resolve(name);
			const m = r?.source === "file" ? meta[name] : null;
			// 元数据只在文件未被手动替换时可信（大小一致）
			const trusted = m && m.size === r.size;
			const job = this.jobs.get(name);
			targets[name] = {
				label: t.label,
				file: t.file,
				asset: t.asset(this.version),
				available: !!r,
				source: !r ? null : r.source === "self" ? "self" : trusted ? m.origin : "manual",
				version: r?.source === "self" ? this.version : trusted ? m.version || null : null,
				size: r?.size || 0,
				sha256: trusted ? m.sha256 : null,
				updatedAt: r ? Math.round(trusted && m.at ? m.at : r.mtimeMs) : null,
				by: trusted ? m.by || null : null,
				job: job ? { kind: job.kind, state: job.state, received: job.received, total: job.total, error: job.error, url: job.url || null, startedAt: job.startedAt } : null,
			};
		}
		return { version: this.version, releaseBaseUrl: this.baseUrl(), releasePage: this.releasePage(), canBuild: this.canBuildFromSelf(), targets };
	}

	/**
	 * 保存安装包（上传或下载的数据流）：边写边校验文件头与大小，完成后原子替换。
	 * @returns {Promise<{size:number, sha256:string}>}
	 */
	async save(name, source, { total = 0, origin = "upload", version = null, by = null, onProgress } = {}) {
		const t = this.target(name);
		if (total > MAX_SIZE) throw err(413, `文件过大（上限 ${MAX_SIZE / 1048576} MB）`);
		fs.mkdirSync(this.dir, { recursive: true });
		const dest = path.join(this.dir, t.file);
		const tmp = path.join(this.dir, `.${t.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`);
		const hash = crypto.createHash("sha256");
		let size = 0;
		let head = Buffer.alloc(0);
		const check = async function* (src) {
			for await (const chunk of src) {
				const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (head.length < t.magic.length) {
					head = Buffer.concat([head, b.subarray(0, t.magic.length - head.length)]);
					if (head.length >= t.magic.length && !head.equals(t.magic)) {
						const archive = (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0x1f && head[1] === 0x8b);
						throw err(400, archive ? `这是压缩包：请上传 ${t.kind}，不要上传 zip / tar.gz 发布包` : `文件类型不对：请上传 ${t.kind}`);
					}
				}
				size += b.length;
				if (size > MAX_SIZE) throw err(413, `文件过大（上限 ${MAX_SIZE / 1048576} MB）`);
				hash.update(b);
				if (onProgress) onProgress(size);
				yield b;
			}
		};
		const out = fs.createWriteStream(tmp, { mode: 0o755 });
		try {
			await pipeline(source, check, out);
			if (size < this.minSize) throw err(400, `文件过小（${size} 字节），不是完整的 ${t.kind}`);
			if (total && size !== total) throw err(400, `文件不完整：收到 ${size} 字节，应为 ${total} 字节`);
			if (t.validate) t.validate(tmp);
			try {
				fs.renameSync(tmp, dest);
			} catch (e) {
				throw err(409, `无法替换现有安装包（${e.code || e.message}），可能正被下载，请稍后重试`);
			}
		} catch (e) {
			// 第一块数据就被拒绝时，写入流可能还在异步打开文件：等它关闭后再删除，否则打开完成后会留下空的临时文件
			if (!out.closed) await Promise.race([once(out, "close").catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
			fs.rmSync(tmp, { force: true });
			if (e.status) throw e;
			throw err(400, e.code === "ERR_STREAM_PREMATURE_CLOSE" || e.code === "ECONNRESET" ? "传输中断，请重试" : e.message);
		}
		const sha256 = hash.digest("hex");
		this.setMeta(name, { origin, version, size, sha256, at: Date.now(), by });
		this.log.info(`[downloads] ${t.label}已更新：${origin}${version ? " " + version : ""}，${(size / 1048576).toFixed(1)} MB，sha256 ${sha256.slice(0, 16)}…`);
		return { size, sha256 };
	}

	/** 后台从发布页下载；同一安装包同时只进行一个任务 */
	startFetch(name, by = null) {
		const t = this.target(name);
		const running = this.jobs.get(name);
		if (running?.state === "running") return running;
		const base = this.baseUrl();
		if (!base) throw err(400, "未配置发布页地址（config.json 的 downloads.releaseBaseUrl 或环境变量 PS_RELEASE_BASE_URL）");
		if (!/^https?:\/\//i.test(base)) throw err(400, "发布页地址必须以 http:// 或 https:// 开头");
		const url = `${base}/${t.asset(this.version)}`;
		const job = { kind: "fetch", state: "running", url, received: 0, total: 0, error: null, startedAt: Date.now() };
		this.jobs.set(name, job);
		(async () => {
			try {
				const res = await this.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": `ps-platform/${this.version}` } });
				if (!res.ok) throw err(502, res.status === 404 ? `发布页没有该文件（HTTP 404）：${url}` : `发布页返回 HTTP ${res.status}`);
				job.total = Number(res.headers.get("content-length")) || 0;
				await this.save(name, Readable.fromWeb(res.body), { total: job.total, origin: "release", version: this.version, by, onProgress: (n) => (job.received = n) });
				job.state = "done";
			} catch (e) {
				job.state = "error";
				const code = e.cause?.code || e.code;
				job.error = e.name === "TimeoutError" ? "下载超时" : e.status ? e.message : `无法连接发布页${code ? `（${code}）` : `：${e.message}`}`;
				this.log.warn(`[downloads] 从发布页获取${t.label}失败：${job.error}`);
			}
		})();
		return job;
	}

	canBuildFromSelf() {
		return !!(this.selfExe && this.platform === "win32" && this.setupStub && fs.existsSync(this.setupStub));
	}

	/**
	 * 平台以 Windows 打包程序运行时：用随包附带的安装向导 + 平台自身生成安装程序（启动时在后台进行，约 10 秒）。
	 * 已有上传 / 获取的安装程序时不覆盖；平台升级后重新生成。
	 */
	async prepare() {
		if (!this.canBuildFromSelf()) return false;
		const t = TARGETS.windows;
		const dest = path.join(this.dir, t.file);
		const m = this.readMeta().windows;
		if (fs.existsSync(dest) && !(m?.origin === "self" && m.version !== this.version)) return false;
		if (this.jobs.get("windows")?.state === "running") return false;
		const total = fs.statSync(this.selfExe).size;
		const job = { kind: "build", state: "running", received: 0, total, error: null, startedAt: Date.now() };
		this.jobs.set("windows", job);
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = path.join(this.dir, `.${t.file}.${process.pid}.build.part`);
		try {
			const out = fs.createWriteStream(tmp);
			const hash = crypto.createHash("sha256");
			let written = 0;
			const put = async (b) => {
				hash.update(b);
				written += b.length;
				await writeChunk(out, b);
			};
			await put(fs.readFileSync(this.setupStub));
			const head = Buffer.alloc(8);
			head.writeBigUInt64LE(BigInt(total));
			await put(head);
			const src = fs.createReadStream(this.selfExe);
			const gz = zlib.createGzip({ level: 6 });
			src.on("data", (c) => (job.received += c.length));
			src.on("error", (e) => gz.destroy(e));
			src.pipe(gz);
			let gzLen = 0;
			for await (const c of gz) {
				gzLen += c.length;
				await put(c);
			}
			await put(trailer(8 + gzLen, AGENT_TAG));
			out.end();
			await once(out, "close");
			fs.renameSync(tmp, dest);
			this.setMeta("windows", { origin: "self", version: this.version, size: written, sha256: hash.digest("hex"), at: Date.now(), by: null });
			job.state = "done";
			this.log.info(`[downloads] 已生成 Windows 安装程序（${(written / 1048576).toFixed(1)} MB）`);
			return true;
		} catch (e) {
			fs.rmSync(tmp, { force: true });
			job.state = "error";
			job.error = e.message;
			this.log.warn(`[downloads] 生成 Windows 安装程序失败：${e.message}`);
			return false;
		}
	}

	/** 删除上传 / 获取的文件（平台自身不可删除） */
	remove(name) {
		const t = this.target(name);
		const f = path.join(this.dir, t.file);
		if (!fs.existsSync(f)) return false;
		fs.rmSync(f, { force: true });
		this.setMeta(name, null);
		this.jobs.delete(name);
		return true;
	}
}

module.exports = { AgentPackages, TARGETS, AGENT_TAG, CONFIG_TAG, trailer, configSection, readSections, agentPayload };
