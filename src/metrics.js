"use strict";
/**
 * 指标：内存环形缓冲的时间序列（最近 1 小时每 10 秒、最近 24 小时每分钟）+ Prometheus 文本输出。
 */
class Ring {
	constructor(size) {
		this.size = size;
		this.items = [];
	}
	push(v) {
		this.items.push(v);
		if (this.items.length > this.size) this.items.shift();
	}
	all() {
		return this.items.slice();
	}
}

class Metrics {
	constructor({ sample }) {
		this.sample = sample; // () => { viewers, external, queued, instances:{...}, turnKbps, gpuUtil, cpu }
		this.fine = new Ring(360); // 10s × 360 = 1h
		this.coarse = new Ring(1440); // 1min × 1440 = 24h
		this.minuteAcc = [];
		this.lastTurn = null;
		this.counters = { playersTotal: 0, instancesStarted: 0, instancesFailed: 0, logins: 0, loginFailures: 0 };
		this.timer = setInterval(() => this.collect(), 10 * 1000);
		this.timer.unref?.();
	}
	stop() {
		clearInterval(this.timer);
	}
	inc(name, n = 1) {
		this.counters[name] = (this.counters[name] || 0) + n;
	}

	collect() {
		const s = this.sample();
		// TURN 中继带宽：两次采样的字节差
		let turnKbps = 0;
		if (s.turnBytes !== undefined && s.turnBytes !== null) {
			if (this.lastTurn && s.turnBytes >= this.lastTurn.bytes) turnKbps = Math.round(((s.turnBytes - this.lastTurn.bytes) * 8) / ((Date.now() - this.lastTurn.at) || 1));
			this.lastTurn = { bytes: s.turnBytes, at: Date.now() };
		}
		const point = { t: Date.now(), viewers: s.viewers, external: s.external, queued: s.queued, instances: s.instancesActive, busy: s.instancesBusy, turnKbps, gpu: s.gpuUtil, cpu: s.cpu };
		this.fine.push(point);
		this.minuteAcc.push(point);
		if (this.minuteAcc.length >= 6) {
			const a = this.minuteAcc;
			const avg = (k) => Math.round(a.reduce((x, p) => x + (p[k] || 0), 0) / a.length);
			const max = (k) => Math.max(...a.map((p) => p[k] || 0));
			this.coarse.push({ t: a[a.length - 1].t, viewers: max("viewers"), external: max("external"), queued: max("queued"), instances: max("instances"), busy: max("busy"), turnKbps: avg("turnKbps"), gpu: avg("gpu"), cpu: avg("cpu") });
			this.minuteAcc = [];
		}
		return point;
	}

	series(range = "1h") {
		return range === "24h" ? this.coarse.all() : this.fine.all();
	}

	prometheus(extra) {
		const s = this.sample();
		const g = (name, help, value, labels = "") => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labels} ${value ?? 0}`;
		const c = (name, help, value) => `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value ?? 0}`;
		const out = [
			g("psp_viewers", "在线观众数", s.viewers),
			g("psp_viewers_external", "外网观众数", s.external),
			g("psp_viewers_queued", "排队观众数", s.queued),
			g("psp_instances_active", "运行中的实例数", s.instancesActive),
			g("psp_instances_busy", "有观众的实例数", s.instancesBusy),
			g("psp_agents_online", "在线 Agent 数", s.agentsOnline),
			g("psp_gpu_util_avg", "GPU 平均利用率(%)", s.gpuUtil),
			c("psp_players_total", "累计观众连接数", this.counters.playersTotal),
			c("psp_instances_started_total", "累计启动实例数", this.counters.instancesStarted),
			c("psp_instances_failed_total", "累计启动失败实例数", this.counters.instancesFailed),
			c("psp_login_failures_total", "累计登录失败次数", this.counters.loginFailures),
			g("psp_uptime_seconds", "进程运行时长", Math.round(process.uptime())),
			g("psp_event_loop_delay_p99_ms", "事件循环延迟 P99（毫秒，持续 >100 说明进程过载）", s.loopDelayMs),
			g("psp_memory_rss_bytes", "进程内存", process.memoryUsage().rss),
		];
		const progs = s.programs || [];
		for (const [name, help, pick] of [
			["psp_program_viewers", "各程序在线观众数", (p) => p.viewers],
			["psp_program_queue", "各程序排队人数", (p) => p.queue],
			["psp_program_instances", "各程序实例数", (p) => p.instances.total],
		]) {
			if (!progs.length) break;
			out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
			for (const p of progs) out.push(`${name}{program="${p.id}"} ${pick(p)}`);
		}
		if (s.turn) {
			out.push(
				g("psp_turn_up", "内置 TURN 在线", 1),
				g("psp_turn_allocations", "TURN 当前分配数", s.turn.allocations),
				c("psp_turn_relay_bytes_down_total", "UE→浏览器中继字节", s.turn.bytesDown),
				c("psp_turn_relay_bytes_up_total", "浏览器→UE中继字节", s.turn.bytesUp),
				c("psp_turn_dropped_packets_total", "拥塞丢弃的中继包", s.turn.dropped)
			);
		} else if (extra?.turnEnabled) out.push(g("psp_turn_up", "内置 TURN 在线", 0));
		return out.join("\n") + "\n";
	}
}

module.exports = { Metrics, Ring };
