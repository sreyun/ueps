"use strict";
/**
 * 端到端测试用"UE 可执行文件"替身：被平台当作 UE 启动（exe = node，args = 本脚本路径），
 * 解析平台下发的 -PixelStreamingURL / -ResX / -ResY，然后用无头浏览器打开 fake-ue.html 作为 UE 推流（libwebrtc，与 UE 同栈）。
 * 平台停止实例时会结束本进程的进程树（Windows taskkill /T），无头浏览器随之退出。
 *
 * 环境变量：FAKE_UE_BROWSER（默认依次尝试 Edge / Chrome）、FAKE_UE_RELAY=1（UE 侧只走 TURN）
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const arg = (flag) => process.argv.find((a) => a.toLowerCase().startsWith(flag.toLowerCase() + "="))?.split("=").slice(1).join("=");
const url = arg("-PixelStreamingURL");
if (!url) {
	console.error("missing -PixelStreamingURL");
	process.exit(2);
}
const candidates = [
	process.env.FAKE_UE_BROWSER,
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].filter(Boolean);
const browser = candidates.find((p) => fs.existsSync(p));
if (!browser) {
	console.error("no headless browser found");
	process.exit(3);
}
const page = pathToFileURL(path.join(__dirname, "fake-ue.html"));
page.searchParams.set("signal", url);
page.searchParams.set("w", arg("-ResX") || "1280");
page.searchParams.set("h", arg("-ResY") || "720");
if (process.env.FAKE_UE_RELAY !== "0") page.searchParams.set("relay", "1");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ue-"));
const child = spawn(
	browser,
	[
		"--headless=new",
		"--disable-gpu",
		...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), // 容器内以 root 运行时 Chromium 必须关闭沙箱
		"--disable-dev-shm-usage",
		"--log-level=3",
		"--no-first-run",
		"--no-default-browser-check",
		"--mute-audio",
		`--user-data-dir=${profile}`,
		"--autoplay-policy=no-user-gesture-required",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows",
		"--allow-file-access-from-files",
		...(process.env.FAKE_UE_DEBUG_PORT ? [`--remote-debugging-port=${process.env.FAKE_UE_DEBUG_PORT}`] : []), // 调试：可用 DevTools 查看替身 UE 的页面日志
		page.href,
	],
	{ stdio: "ignore" }
);
const cleanup = () => {
	try {
		child.kill();
	} catch {}
	try {
		fs.rmSync(profile, { recursive: true, force: true });
	} catch {}
};
child.on("exit", (code) => {
	cleanup();
	process.exit(code ?? 0);
});
process.on("SIGTERM", () => (cleanup(), process.exit(0)));
process.on("SIGINT", () => (cleanup(), process.exit(0)));
