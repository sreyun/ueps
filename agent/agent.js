"use strict";
/**
 * ps-agent：渲染节点代理。负责在本机拉起/停止 UE 进程，并上报 CPU / 内存 / GPU / 进程状态。
 *
 * 独立运行（每台渲染机一个）：
 *   Windows：管理端「接入渲染机」下载图形安装程序（ps-platform-agent-setup.exe），按向导安装即可（见 agent-setup/）
 *   node agent/agent.js --url ws://<平台内网IP>:88/agent --token <agentToken> [--id render-01] [--allow-exe D:\UE]
 *   ps-platform.exe --agent --url ws://... --token ...      或      ps-platform.exe --agent --config agent.json
 * 也可被平台以"内置本机 Agent"的方式在进程内使用（createAgent）。
 *
 * 安全：以参数数组 spawn（不经 shell，杜绝命令注入）；--allow-exe 限定可执行文件前缀；只连接内网平台地址。
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");

const VERSION = "1.0.0";
const isWin = process.platform === "win32";

/** 查询 NVIDIA GPU（无 nvidia-smi 时返回 []） */
function queryGpus() {
	return new Promise((resolve) => {
		execFile(
			"nvidia-smi",
			["--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
			{ timeout: 4000, windowsHide: true },
			(err, stdout) => {
				if (err) return resolve([]);
				const gpus = stdout
					.trim()
					.split(/\r?\n/)
					.filter(Boolean)
					.map((line) => {
						const [index, name, total, used, util, temp] = line.split(",").map((s) => s.trim());
						return { index: +index, name, memTotalMB: +total || 0, memUsedMB: +used || 0, util: +util || 0, temp: +temp || 0 };
					});
				resolve(gpus);
			}
		);
	});
}

/** CPU 使用率（两次采样之间） */
function cpuSampler() {
	let last = os.cpus().map((c) => c.times);
	return () => {
		const now = os.cpus().map((c) => c.times);
		let idle = 0;
		let total = 0;
		now.forEach((t, i) => {
			const l = last[i] || t;
			const d = (k) => t[k] - l[k];
			const tot = d("user") + d("nice") + d("sys") + d("idle") + d("irq");
			total += tot;
			idle += d("idle");
		});
		last = now;
		return total ? Math.round((100 * (total - idle)) / total) : 0;
	};
}

/** 进程是否存活 */
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
}

/** 进程存活且映像名与 exe 一致（防止 PID 被系统复用后误杀/误接管其它进程） */
function pidMatches(pid, exe) {
	return new Promise((resolve) => {
		if (!pid || !pidAlive(pid)) return resolve(false);
		const want = path.basename(exe || "").toLowerCase();
		if (!want) return resolve(false);
		if (isWin) {
			execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }, (err, out) => {
				if (err) return resolve(false);
				const name = (String(out).match(/^"([^"]+)"/m) || [])[1] || "";
				resolve(name.toLowerCase() === want);
			});
			return;
		}
		try {
			resolve(path.basename(fs.readlinkSync(`/proc/${pid}/exe`)).toLowerCase() === want);
		} catch {
			resolve(true); // 无 /proc（如 macOS）：仅凭 PID 存活判断
		}
	});
}

function killTree(pid) {
	if (!pid) return;
	if (isWin) {
		execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGTERM"); // detached 进程组
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}, 5000).unref();
}

/**
 * 创建 Agent 核心（与传输无关）。send(msg) 把消息发给平台；返回 { handle(msg), hello(), close() }。
 */
function createAgent({ send, machineId, allowExe = [], log = console, statsIntervalMs = 5000, gpuProvider = queryGpus, stateFile = null }) {
	const procs = new Map(); // instanceId -> { child, pid, startedAt, programId, gpu, exe, adopted }
	const cpu = cpuSampler();
	let gpus = [];
	let closed = false;

	/*
	 * 进程表持久化：Agent / 平台异常重启后，仍在运行的 UE 进程会被重新接管（上报给平台），
	 * 而不是变成占用显卡、无人管理的"孤儿进程"。
	 */
	function saveState() {
		if (!stateFile) return;
		const list = [...procs.entries()].map(([instanceId, p]) => ({ instanceId, pid: p.pid, programId: p.programId, gpu: p.gpu, exe: p.exe, startedAt: p.startedAt }));
		try {
			fs.writeFileSync(stateFile, JSON.stringify(list));
		} catch (e) {
			log.warn?.(`[agent] 保存进程表失败：${e.message}`);
		}
	}
	async function loadState() {
		if (!stateFile) return;
		let list = [];
		try {
			list = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		} catch {
			return;
		}
		for (const e of Array.isArray(list) ? list : []) {
			if (!e?.instanceId || procs.has(e.instanceId)) continue;
			if (await pidMatches(e.pid, e.exe)) {
				procs.set(e.instanceId, { child: null, pid: e.pid, startedAt: e.startedAt || Date.now(), programId: e.programId, gpu: e.gpu ?? null, exe: e.exe, adopted: true });
				log.info?.(`[agent] 接管仍在运行的实例 ${e.instanceId} pid=${e.pid}`);
			}
		}
		saveState();
	}
	const ready = loadState().catch(() => {});

	/** 接管的进程没有 child 句柄，靠轮询判断退出 */
	function pollAdopted() {
		for (const [instanceId, p] of procs) {
			if (!p.adopted || pidAlive(p.pid)) continue;
			procs.delete(instanceId);
			saveState();
			send({ type: "exited", instanceId, code: null, signal: "gone" });
		}
	}

	/** 白名单按目录边界匹配："D:\UE" 允许 "D:\UE\a.exe"，不允许 "D:\UE-evil\a.exe"；先解析符号链接/联接点 */
	const allowed = (exe) => {
		if (!allowExe.length) return true;
		const real = (s) => {
			try {
				return fs.realpathSync.native(s);
			} catch {
				return path.resolve(s);
			}
		};
		const norm = (s) => (isWin ? real(s).toLowerCase() : real(s));
		const target = norm(exe);
		return allowExe.some((p) => {
			const dir = norm(p).replace(/[\\/]+$/, "");
			return target === dir || target.startsWith(dir + path.sep);
		});
	};

	async function refreshGpus() {
		gpus = await gpuProvider();
	}

	function info() {
		return {
			machineId,
			hostname: os.hostname(),
			platform: `${os.platform()} ${os.release()}`,
			version: VERSION,
			cpus: os.cpus().length,
			memTotalMB: Math.round(os.totalmem() / 1048576),
			gpus,
		};
	}

	function stats() {
		return {
			type: "stats",
			cpu: cpu(),
			memUsedMB: Math.round((os.totalmem() - os.freemem()) / 1048576),
			gpus,
			procs: procList(),
		};
	}

	function procList() {
		return [...procs.entries()].map(([instanceId, p]) => ({ instanceId, pid: p.pid, programId: p.programId || null, gpu: p.gpu ?? null, uptime: Math.round((Date.now() - p.startedAt) / 1000) }));
	}

	function start({ instanceId, exe, args = [], cwd, programId = null, gpu = null }) {
		if (typeof instanceId !== "string" || !instanceId || !Array.isArray(args) || args.some((a) => typeof a !== "string")) return;
		if (procs.has(instanceId)) return;
		if (!exe) return send({ type: "error", instanceId, message: "程序未配置可执行文件路径" });
		if (!allowed(exe)) return send({ type: "error", instanceId, message: `不在 allowExe 白名单内：${exe}` });
		if (!fs.existsSync(exe)) return send({ type: "error", instanceId, message: `可执行文件不存在：${exe}` });
		let child;
		try {
			child = spawn(exe, args, {
				cwd: cwd || path.dirname(exe),
				detached: !isWin,
				windowsHide: false,
				stdio: "ignore",
			});
		} catch (e) {
			return send({ type: "error", instanceId, message: e.message });
		}
		const entry = { child, pid: child.pid, startedAt: Date.now(), programId, gpu, exe };
		procs.set(instanceId, entry);
		child.once("error", (e) => {
			if (procs.get(instanceId) === entry) procs.delete(instanceId);
			saveState();
			send({ type: "error", instanceId, message: e.message });
		});
		child.once("exit", (code, signal) => {
			if (procs.get(instanceId) === entry) procs.delete(instanceId);
			saveState();
			send({ type: "exited", instanceId, code, signal });
		});
		saveState();
		if (child.pid) {
			log.info?.(`[agent] started ${instanceId} pid=${child.pid} ${exe}`);
			send({ type: "started", instanceId, pid: child.pid });
		}
	}

	function stop({ instanceId }) {
		const p = procs.get(instanceId);
		if (!p) return send({ type: "exited", instanceId, code: null, signal: "not-running" });
		log.info?.(`[agent] stopping ${instanceId} pid=${p.pid}`);
		killTree(p.pid);
	}

	function handle(msg) {
		if (!msg || closed) return;
		if (msg.type === "start") start(msg);
		else if (msg.type === "stop") stop(msg);
		else if (msg.type === "ping") send({ type: "pong" });
	}

	const timer = setInterval(async () => {
		pollAdopted();
		await refreshGpus().catch(() => {});
		send(stats());
	}, statsIntervalMs);
	timer.unref?.();

	return {
		async hello() {
			await ready;
			await refreshGpus().catch(() => {});
			send({ type: "hello", ...info(), procs: procList() }); // 带上当前进程表，平台据此接管/清理
			send(stats());
		},
		handle,
		procs,
		ready,
		/** 停止所有由本 Agent 拉起的 UE（Agent / 平台正常退出时调用） */
		killAll() {
			for (const p of procs.values()) killTree(p.pid);
			procs.clear();
			saveState();
		},
		close() {
			closed = true;
			clearInterval(timer);
		},
	};
}

/* --------------------------------------------------------------- 独立运行 */

function parseArgs(argv) {
	const o = { allowExe: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--url") o.url = argv[++i];
		else if (a === "--token") o.token = argv[++i];
		else if (a === "--id") o.id = argv[++i];
		else if (a === "--allow-exe") o.allowExe.push(argv[++i]);
		else if (a === "--insecure") o.insecure = true;
		else if (a === "--state") o.state = argv[++i];
		else if (a === "--config") o.config = argv[++i];
	}
	// --config agent.json：Windows 安装程序写入的配置（令牌不出现在命令行 / 进程列表中）；命令行参数优先
	if (o.config) {
		let c;
		try {
			c = JSON.parse(fs.readFileSync(o.config, "utf8").replace(/^﻿/, ""));
		} catch (e) {
			throw new Error(`无法读取 Agent 配置文件 ${o.config}：${e.message}`);
		}
		o.url = o.url || c.url;
		o.token = o.token || c.token;
		o.id = o.id || c.id;
		if (!o.allowExe.length && Array.isArray(c.allowExe)) o.allowExe.push(...c.allowExe);
		o.state = o.state || c.state;
		if (c.insecure) o.insecure = true;
	}
	o.url = o.url || process.env.PS_AGENT_URL;
	o.token = o.token || process.env.PS_AGENT_TOKEN || "";
	o.id = o.id || process.env.PS_AGENT_ID || os.hostname().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	if (process.env.PS_AGENT_ALLOW_EXE) o.allowExe.push(...process.env.PS_AGENT_ALLOW_EXE.split(","));
	// Windows 上 "D:\UE\" 会被解析成 D:\UE"（\" 是转义的引号）：去掉误带的引号，避免白名单永远不匹配
	o.allowExe = o.allowExe.map((s) => String(s || "").trim().replace(/^"+|"+$/g, "")).filter(Boolean);
	// 进程表文件：Agent 异常重启后据此接管仍在运行的 UE（放在临时目录：重启电脑后自然失效）
	o.state = o.state || process.env.PS_AGENT_STATE || path.join(os.tmpdir(), `ps-agent-${o.id}.json`);
	return o;
}

function main(argv = process.argv.slice(2)) {
	const WebSocket = require("ws");
	let o;
	try {
		o = parseArgs(argv);
	} catch (e) {
		console.error(`[agent] ${e.message}`);
		process.exit(2);
	}
	if (!o.url) {
		console.error("用法：agent --url ws://<平台内网IP>:88/agent --token <agentToken> [--id 机器名] [--allow-exe 路径前缀]  或  agent --config agent.json");
		process.exit(2);
	}
	let ws = null;
	let retry = 0;
	const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
	const agent = createAgent({ send, machineId: o.id, allowExe: o.allowExe, stateFile: o.state });
	if (!o.allowExe.length) console.warn("[agent] 警告：未设置 --allow-exe，平台可以让本机启动任意可执行文件。生产环境请限定 UE 安装目录。");
	if (/^ws:/i.test(o.url) && !/^ws:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/i.test(o.url)) console.warn("[agent] 警告：通过公网明文 ws:// 连接平台，令牌可能被窃听，请改用内网地址或 wss://");

	const connect = () => {
		const u = new URL(o.url);
		if (o.token) u.searchParams.set("token", o.token);
		u.searchParams.set("id", o.id);
		ws = new WebSocket(u.href, "ps-agent", { rejectUnauthorized: !o.insecure, perMessageDeflate: false });
		ws.on("open", () => {
			retry = 0;
			console.log(`[agent] connected ${o.url} as ${o.id}`);
			agent.hello();
		});
		ws.on("message", (raw) => {
			try {
				agent.handle(JSON.parse(raw));
			} catch {}
		});
		ws.on("close", (code) => {
			const delay = Math.min(15, 2 ** retry++) * 1000;
			console.log(`[agent] disconnected (${code}), retry in ${delay / 1000}s`);
			setTimeout(connect, delay);
		});
		ws.on("error", (e) => console.log(`[agent] ${e.message}`));
	};
	connect();
	const shutdown = () => {
		agent.killAll();
		setTimeout(() => process.exit(0), 300);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (require.main === module) main();

module.exports = { createAgent, queryGpus, main, parseArgs, VERSION, pidAlive, pidMatches };
