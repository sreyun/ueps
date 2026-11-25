#!/usr/bin/env node
"use strict";
/**
 * ps-platform 入口。一个程序三种角色：
 *   node server.js                    管理平台（信令 + 调度 + 管理端 + 内置 TURN）
 *   node server.js --turn [turn.json] 只运行 TURN 中继（平台内部以子进程方式使用）
 *   node server.js --agent --url ws://平台:88/agent --token xxx   渲染节点代理
 * 打包成 exe 后同样适用：ps-platform.exe / ps-platform.exe --turn / ps-platform.exe --agent ...
 */
const path = require("path");

const IS_SEA = (() => {
	try {
		return require("node:sea").isSea();
	} catch {
		return false;
	}
})();

if (process.argv.includes("--turn")) {
	require("./lib/turn-tcp.js").main(process.argv);
} else if (process.argv.includes("--agent")) {
	require("./agent/agent.js").main(process.argv.slice(2).filter((a) => a !== "--agent"));
} else if (process.argv.includes("--reset-password")) {
	// 忘记口令：ps-platform --reset-password [用户名]（新口令取环境变量 PS_NEW_PASSWORD，否则随机生成并写入 data/initial-admin.txt）
	// 同时解除禁用、清除两步验证、让该用户所有已登录会话失效。平台运行中也可执行。
	const fs = require("fs");
	const { loadConfig } = require("./src/config.js");
	const { Store } = require("./src/store.js");
	const { hashPassword, checkPasswordPolicy } = require("./src/auth.js");
	const { randomSecret } = require("./src/util.js");
	const name = process.argv[process.argv.indexOf("--reset-password") + 1] || "admin";
	const config = loadConfig({ baseDir: process.env.PS_HOME || (IS_SEA ? path.dirname(process.execPath) : __dirname) });
	const store = new Store(config.dataDir);
	const u = store.getUserByName(name.startsWith("--") ? "admin" : name);
	if (!u) {
		console.error(`用户不存在：${name}`);
		process.exit(1);
	}
	const password = process.env.PS_NEW_PASSWORD || randomSecret(6) + "A1";
	const bad = checkPasswordPolicy(password);
	if (bad) {
		console.error(bad);
		process.exit(1);
	}
	store.updateUser(u.id, { password_hash: hashPassword(password), token_version: (u.token_version || 0) + 1, disabled: false, totp_secret: null });
	store.setSetting(`mustChange:${u.id}`, true);
	store.audit({ username: "cli", action: "user.reset_password_cli", target: u.username });
	if (!process.env.PS_NEW_PASSWORD) {
		const f = path.join(config.dataDir, "initial-admin.txt");
		fs.writeFileSync(f, `用户名: ${u.username}\n新口令: ${password}\n登录后请立即修改口令，然后删除本文件。\n`, { mode: 0o600 });
		console.log(`已重置 ${u.username} 的口令，新口令见 ${f}`);
	} else console.log(`已重置 ${u.username} 的口令`);
	store.close();
} else {
	const { loadConfig } = require("./src/config.js");
	const { createApp } = require("./src/app.js");
	const baseDir = process.env.PS_HOME || (IS_SEA ? path.dirname(process.execPath) : __dirname);
	let config;
	try {
		config = loadConfig({ baseDir });
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
	const app = createApp({
		config,
		assetsDir: process.env.PS_ASSETS || baseDir,
		selfCommand: IS_SEA ? [process.execPath] : [process.execPath, __filename],
	});
	app.start().catch((e) => {
		console.error("启动失败：", e.message);
		process.exit(1);
	});
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		app.stop().finally(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// 记录但不退出：单个连接/请求的异常不应中断所有观众的信令（日志中出现时请排查）
	process.on("uncaughtException", (e) => app.log.error("[process] uncaughtException:", e));
	process.on("unhandledRejection", (e) => app.log.error("[process] unhandledRejection:", e));
}
