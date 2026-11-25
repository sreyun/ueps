import { html, useStore, usePoll, api, run, Card, Table, StateBadge, Badge, fmt, can, useState, confirmDialog } from "../lib.js";

export function Sessions() {
	const [tab, setTab] = useState("live");
	return html`
		<div class="seg big">
			${[
				["live", "实时观众"],
				["history", "历史会话"],
				["stats", "统计"],
			].map(([k, l]) => html`<button class=${tab === k ? "on" : ""} onClick=${() => setTab(k)}>${l}</button>`)}
		</div>
		${tab === "live" ? html`<${Live} />` : tab === "history" ? html`<${History} />` : html`<${Stats} />`}
	`;
}

const linkLabel = (t) => {
	if (!t) return "-";
	if (t.startsWith("relay/tcp") || t.startsWith("relay/tls")) return html`<${Badge} tone="warn">TURN ${t.includes("tls") ? "TLS" : "TCP"}<//>`;
	if (t.startsWith("relay")) return html`<${Badge} tone="info">TURN UDP<//>`;
	if (t.startsWith("host")) return html`<${Badge} tone="ok">直连<//>`;
	return html`<${Badge}>${t.split("→")[0]}<//>`;
};

function Live() {
	const s = useStore();
	const players = s.overview?.players || [];
	const programs = s.overview?.programs || [];
	const kick = (p) => confirmDialog(`确定断开观众 ${p.ip}？`) && run(() => api("POST", `/sessions/${p.id}/kick`), "已断开");
	return html`<${Card} title=${`实时观众（${players.length}）`}>
		<${Table}
			rows=${players}
			empty="当前没有观众"
			columns=${[
				{ title: "观众", render: (p) => html`<b>${p.ip}</b> ${p.external ? html`<${Badge} tone="info">外网<//>` : html`<${Badge}>内网<//>`}<div class="muted small ellipsis" title=${p.userAgent}>${p.userAgent}</div>` },
				{ title: "程序", render: (p) => programs.find((x) => x.id === p.programId)?.name || p.programId },
				{ title: "状态", render: (p) => html`<${StateBadge} state=${p.state} />${p.state === "queued" ? html`<div class="muted small">第 ${p.queuePos} 位</div>` : ""}` },
				{ title: "实例", render: (p) => (p.instanceId ? html`<code>${p.instanceId}</code><div class="muted small">${p.machineId}</div>` : "-") },
				{ title: "链路", render: (p) => linkLabel(p.qos?.transport) },
				{ title: "码率", render: (p) => fmt.kbps(p.qos?.kbps) },
				{ title: "画面", render: (p) => (p.qos?.w ? `${p.qos.w}×${p.qos.h} @${p.qos.fps ?? "-"}` : "-") },
				{ title: "延迟", render: (p) => (p.qos?.rtt !== null && p.qos?.rtt !== undefined ? html`<span class=${p.qos.rtt < 60 ? "text-ok" : p.qos.rtt < 150 ? "text-warn" : "text-bad"}>${p.qos.rtt} ms</span>` : "-") },
				{ title: "丢包", render: (p) => p.qos?.lost ?? "-" },
				{ title: "时长", render: (p) => fmt.since(p.assignedAt || p.joinedAt) },
				{ title: "", class: "actions", render: (p) => can("operator") && html`<button class="danger sm" onClick=${() => kick(p)}>断开</button>` },
			]}
		/>
	<//>`;
}

function History() {
	const [q, setQ] = useState({ program: "", ip: "", offset: 0 });
	const limit = 50;
	const list = usePoll(() => api("GET", `/sessions/history?limit=${limit}&offset=${q.offset}&program=${encodeURIComponent(q.program)}&ip=${encodeURIComponent(q.ip)}`), [q.program, q.ip, q.offset]);
	const d = list.data || { total: 0, rows: [] };
	return html`<${Card}
		title=${`历史会话（${d.total}）`}
		extra=${html`<input class="sm" placeholder="程序 ID" value=${q.program} onChange=${(e) => setQ({ ...q, program: e.target.value.trim(), offset: 0 })} />
			<input class="sm" placeholder="IP 包含" value=${q.ip} onChange=${(e) => setQ({ ...q, ip: e.target.value.trim(), offset: 0 })} />`}
	>
		<${Table}
			rows=${d.rows}
			empty="暂无记录"
			columns=${[
				{ title: "开始", render: (r) => fmt.time(r.started_at) },
				{ title: "时长", render: (r) => fmt.dur((r.ended_at || Date.now()) - r.started_at) },
				{ title: "程序", key: "program_id" },
				{ title: "观众", render: (r) => html`${r.client_ip} ${r.external ? html`<${Badge} tone="info">外网<//>` : ""}` },
				{ title: "实例 / 机器", render: (r) => html`<code>${r.instance_id || "-"}</code> <span class="muted small">${r.machine_id || ""}</span>` },
				{ title: "链路", render: (r) => linkLabel(r.transport) },
				{ title: "平均码率", render: (r) => fmt.kbps(r.avg_kbps) },
				{ title: "平均延迟", render: (r) => (r.avg_rtt_ms ? `${r.avg_rtt_ms} ms` : "-") },
				{ title: "结束原因", render: (r) => r.end_reason || (r.ended_at ? "-" : html`<${Badge} tone="accent">进行中<//>`) },
			]}
		/>
		<div class="pager">
			<button class="ghost sm" disabled=${q.offset === 0} onClick=${() => setQ({ ...q, offset: Math.max(0, q.offset - limit) })}>上一页</button>
			<span class="muted small">${d.total ? `${q.offset + 1}-${Math.min(d.total, q.offset + limit)} / ${d.total}` : ""}</span>
			<button class="ghost sm" disabled=${q.offset + limit >= d.total} onClick=${() => setQ({ ...q, offset: q.offset + limit })}>下一页</button>
		</div>
	<//>`;
}

function Stats() {
	const [days, setDays] = useState(7);
	const st = usePoll(() => api("GET", `/sessions/stats?days=${days}`), [days]);
	const rows = (st.data?.programs || []).sort((a, b) => b.total_ms - a.total_ms);
	return html`<${Card}
		title="使用统计"
		extra=${html`<div class="seg">${[1, 7, 30].map((d) => html`<button class=${days === d ? "on" : ""} onClick=${() => setDays(d)}>${d} 天</button>`)}</div>`}
	>
		<${Table}
			rows=${rows}
			rowKey=${(r) => r.program_id}
			empty="暂无数据"
			columns=${[
				{ title: "程序", key: "program_id" },
				{ title: "会话数", render: (r) => fmt.num(r.sessions) },
				{ title: "外网会话", render: (r) => fmt.num(r.external) },
				{ title: "累计观看时长", render: (r) => fmt.dur(r.total_ms) },
				{ title: "平均时长", render: (r) => fmt.dur(r.sessions ? r.total_ms / r.sessions : 0) },
			]}
		/>
	<//>`;
}
