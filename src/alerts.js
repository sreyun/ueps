"use strict";
/**
 * 告警：把关键事件推送到 Webhook（通用 JSON / 企业微信 / 钉钉 / 飞书机器人）。同一事件 60 秒内只推一次。
 */
const http = require("http");
const https = require("https");

const EVENTS = {
	"agent.offline": "渲染机离线",
	"agent.online": "渲染机上线",
	"instance.failed": "实例启动失败",
	"program.capacity": "资源不足（无可用机器/GPU）",
	"queue.backlog": "观众排队积压",
	"turn.down": "内置 TURN 异常退出",
	"security.login_locked": "登录失败次数过多被锁定",
};

class Alerts {
	constructor({ settings, log }) {
		this.settings = settings;
		this.log = log;
		this.last = new Map();
		this.sent = 0;
	}

	notify(event, text, data = {}) {
		const cfg = this.settings().alerts || {};
		if (!cfg.webhook || !(cfg.events || []).includes(event)) return false;
		const key = `${event}:${data.key || ""}`;
		const now = Date.now();
		if (now - (this.last.get(key) || 0) < (cfg.throttleSec ?? 60) * 1000) return false;
		this.last.set(key, now);
		const title = `【${cfg.name || "云渲染管理平台"}】${EVENTS[event] || event}`;
		const content = `${title}\n${text}\n时间：${new Date(now).toLocaleString("zh-CN", { hour12: false })}`;
		let body;
		switch (cfg.format) {
			case "wecom":
			case "dingtalk":
				body = { msgtype: "text", text: { content } };
				break;
			case "feishu":
				body = { msg_type: "text", content: { text: content } };
				break;
			default:
				body = { event, title, text, time: now, data };
		}
		this.post(cfg.webhook, body).catch((e) => this.log.warn(`[alerts] 推送失败：${e.message}`));
		return true;
	}

	post(url, body) {
		return new Promise((resolve, reject) => {
			let u;
			try {
				u = new URL(url);
			} catch {
				return reject(new Error("Webhook 地址无效"));
			}
			const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
			if (!mod) return reject(new Error("Webhook 只支持 http/https"));
			const data = JSON.stringify(body);
			const req = mod.request(u, { method: "POST", timeout: 5000, headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) } }, (res) => {
				res.resume();
				this.sent++;
				res.statusCode < 400 ? resolve(res.statusCode) : reject(new Error(`HTTP ${res.statusCode}`));
			});
			req.on("timeout", () => req.destroy(new Error("超时")));
			req.on("error", reject);
			req.end(data);
		});
	}
}

module.exports = { Alerts, ALERT_EVENTS: EVENTS };
