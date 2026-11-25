"use strict";
/**
 * 打包单文件可执行程序（Node.js SEA）：dist/ps-platform(.exe) + 运行时资源
 *
 *   npm install          # 安装 esbuild（仅打包需要）
 *   npm run build:exe
 *
 * 产物（dist/，整个目录拷到目标机器即可运行，无需安装 Node.js）：
 *   ps-platform.exe                 一个文件三种角色：
 *                                     ps-platform.exe                        管理平台（读取同目录 config.json）
 *                                     ps-platform.exe --agent --url ... ...  渲染节点 Agent
 *                                     ps-platform.exe --turn                 TURN 中继（平台内部以子进程方式使用）
 *   admin/  public/                 管理端与播放页静态资源
 *   config.example.json             配置示例（复制为 config.json 后修改）
 *   docs/                           安装文档
 *
 * 要求：Node.js >= 25.5（--build-sea）；低版本自动退回 --experimental-sea-config + postject。
 * 在哪个平台打包就生成哪个平台的可执行文件（Windows 生成 .exe，Linux 生成 ELF）。
 * 注意：平台使用内置 node:sqlite，打包用的 Node 版本需 >= 22.13。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const exe = process.platform === "win32" ? "ps-platform.exe" : "ps-platform";

let esbuild;
try {
	esbuild = require("esbuild");
} catch {
	console.error("缺少 esbuild：请先在 ps-platform 目录执行 npm install（打包依赖，运行时不需要）");
	process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1) 打包成单个 CommonJS 文件（ws 的可选原生依赖不打包，ws 会自动退回纯 JS 实现；node:* 内置模块保持外部引用）
const bundle = path.join(DIST, "ps-platform.bundle.cjs");
esbuild.buildSync({
	entryPoints: [path.join(ROOT, "server.js")],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	outfile: bundle,
	external: ["bufferutil", "utf-8-validate", "node:sqlite", "node:sea"],
	legalComments: "none",
	logLevel: "warning",
});
console.log("bundled ->", path.relative(ROOT, bundle));

// 2) 生成 SEA
const seaConfig = path.join(DIST, "sea-config.json");
const output = path.join(DIST, exe);
const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 25 || (major === 25 && minor >= 5)) {
	fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2));
	execFileSync(process.execPath, ["--build-sea", seaConfig], { stdio: "inherit" });
} else {
	const blob = path.join(DIST, "sea-prep.blob");
	fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2));
	execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
	fs.copyFileSync(process.execPath, output);
	const npx = process.platform === "win32" ? "npx.cmd" : "npx";
	const args = ["--yes", "postject", output, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
	if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
	execFileSync(npx, args, { stdio: "inherit", shell: process.platform === "win32" });
	fs.rmSync(blob, { force: true });
}
fs.rmSync(seaConfig, { force: true });
fs.rmSync(bundle, { force: true });
console.log("executable ->", path.relative(ROOT, output));

// 3) 运行时资源
for (const dir of ["admin", "public"]) fs.cpSync(path.join(ROOT, dir), path.join(DIST, dir), { recursive: true });
fs.copyFileSync(path.join(ROOT, "config.example.json"), path.join(DIST, "config.example.json"));
fs.mkdirSync(path.join(DIST, "docs"), { recursive: true });
for (const f of ["INSTALL.md", "API.md"]) if (fs.existsSync(path.join(ROOT, "docs", f))) fs.copyFileSync(path.join(ROOT, "docs", f), path.join(DIST, "docs", f));
fs.cpSync(path.join(ROOT, "deploy", "nginx"), path.join(DIST, "nginx"), { recursive: true });
console.log("done. 运行：", path.join("dist", exe));
