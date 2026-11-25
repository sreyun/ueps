"use strict";
/**
 * 打包单文件可执行程序（Node.js SEA）+ 运行时资源，并生成发布压缩包。
 *
 *   npm install          # 安装 esbuild（仅打包需要）
 *   npm run build:exe
 *
 * 在哪个系统上打包就生成哪个系统的程序：
 *   Windows → dist/ps-platform-<版本>-windows-x64/ps-platform.exe   + dist/ps-platform-<版本>-windows-x64.zip
 *   Linux   → dist/ps-platform-<版本>-linux-x64/ps-platform        + dist/ps-platform-<版本>-linux-x64.tar.gz
 *   （Linux 请用 glibc 版 Node 打包，例如 node:26-bookworm-slim 镜像，产物可在主流发行版运行；不要用 Alpine/musl 版）
 *
 * 包内容：可执行文件（一个文件三种角色：平台 / --agent 渲染机代理 / --turn 中继）、admin/、public/、
 *         config.example.json、nginx/、docs/、运行说明.txt。整个目录拷到目标机器即可运行，无需安装 Node.js。
 *
 * 要求：Node.js >= 25.5（--build-sea）；低版本自动退回 --experimental-sea-config + postject。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const pkg = require(path.join(ROOT, "package.json"));
const isWin = process.platform === "win32";
const osName = isWin ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const name = `ps-platform-${pkg.version}-${osName}-${process.arch}`;
const OUT = path.join(DIST, name);
const exe = isWin ? "ps-platform.exe" : "ps-platform";

let esbuild;
try {
	esbuild = require("esbuild");
} catch {
	console.error("缺少 esbuild：请先在 ps-platform 目录执行 npm install（打包依赖，运行时不需要）");
	process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

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
const output = path.join(OUT, exe);
const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 25 || (major === 25 && minor >= 5)) {
	fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2));
	execFileSync(process.execPath, ["--build-sea", seaConfig], { stdio: "inherit" });
} else {
	const blob = path.join(DIST, "sea-prep.blob");
	fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2));
	execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
	fs.copyFileSync(process.execPath, output);
	const npx = isWin ? "npx.cmd" : "npx";
	const args = ["--yes", "postject", output, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
	if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
	execFileSync(npx, args, { stdio: "inherit", shell: isWin });
	fs.rmSync(blob, { force: true });
}
fs.rmSync(seaConfig, { force: true });
fs.rmSync(bundle, { force: true });
if (!isWin) fs.chmodSync(output, 0o755);
console.log("executable ->", path.relative(ROOT, output));

// 3) 运行时资源
for (const dir of ["admin", "public"]) fs.cpSync(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true });
fs.copyFileSync(path.join(ROOT, "config.example.json"), path.join(OUT, "config.example.json"));
fs.mkdirSync(path.join(OUT, "docs"), { recursive: true });
for (const f of ["INSTALL.md", "API.md"]) if (fs.existsSync(path.join(ROOT, "docs", f))) fs.copyFileSync(path.join(ROOT, "docs", f), path.join(OUT, "docs", f));
for (const f of ["README.md", "CHANGELOG.md", "NOTICE.md"]) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
fs.cpSync(path.join(ROOT, "deploy", "nginx"), path.join(OUT, "nginx"), { recursive: true });
const run = isWin ? ".\\ps-platform.exe" : "./ps-platform";
const guide = [
	`ps-platform ${pkg.version}（${osName} ${process.arch}）`,
	"",
	"1. 复制配置：" + (isWin ? "copy config.example.json config.json" : "cp config.example.json config.json") + "，按 docs/INSTALL.md 第 6 节修改",
	`2. 启动平台：${run}`,
	"   管理端：http://<本机IP>:88/admin/ ，初始口令见 data" + (isWin ? "\\" : "/") + "initial-admin.txt（或启动前设置环境变量 PS_ADMIN_PASSWORD）",
	`3. 渲染机代理：${run} --agent --url ws://<平台内网IP>:88/agent --token <令牌> --id <机器名> --allow-exe <UE 所在目录>`,
	`4. 忘记口令：${run} --reset-password admin`,
	"",
	isWin ? "注册为 Windows 服务（开机自启）：见 docs/INSTALL.md 4.3（NSSM）" : "注册为 systemd 服务（开机自启）：见 docs/INSTALL.md 4.3",
	"对外服务需配合 nginx（单端口多路复用）：nginx/nginx.conf，说明见 docs/INSTALL.md",
	"",
].join(isWin ? "\r\n" : "\n");
fs.writeFileSync(path.join(OUT, "运行说明.txt"), guide);

// 4) 发布压缩包（Windows 10+ 与 Linux 均自带 tar；Windows 的 tar 可直接生成 zip）
const archiveName = isWin ? `${name}.zip` : `${name}.tar.gz`;
const archive = path.join(DIST, archiveName);
fs.rmSync(archive, { force: true });
// Windows 用系统自带的 bsdtar（System32\tar.exe，可写 zip）；避免 Git Bash 等环境里的 GNU tar 把 "C:" 当成远程主机
const winTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const tarCmd = isWin && fs.existsSync(winTar) ? winTar : "tar";
execFileSync(tarCmd, isWin ? ["-a", "-cf", archiveName, name] : ["-czf", archiveName, name], { stdio: "inherit", cwd: DIST });
console.log("archive    ->", path.relative(ROOT, archive), `(${(fs.statSync(archive).size / 1048576).toFixed(1)} MB)`);
