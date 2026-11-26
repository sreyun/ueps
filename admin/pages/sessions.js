import { html, useStore, usePoll, api, run, Card, Table, StateBadge, Badge, fmt, can, useState, confirmDialog, Tabs, download } from "../lib.js";

export function Sessions() {
	const s = useStore();
	const [tab, setTab] = useState("live");
	const live = s.overview?.players?.length || 0;
	return html`
		<${Tabs}
			tabs=${[
				["live", "实时观众", live || ""],
				["history", "历史会话"],
				["stats", "使用统计"],
			]}
			value=${tab}
			onChange=${setTab}
		/>
		${tab === "live" ? html`<${Live} />` : tab === "history" ? html`<${History} />` : html`<${Stats} />`}
	`;
}

const linkLabel = (t) => {
	if (!t) return "-";
	if (t.startsWith("relay/tcp") || t.startsWith("relay/tls")) return html`<${Badge} tone="warn" title="经 nginx 同端口 TURN 中继">TURN ${t.includes("tls") ? "TLS" : "TCP"}<//>`;
	if (t.startsWith("relay")) return html`<${Badge} tone="info" title="经 TURN UDP 中继">TURN UDP<//>`;
	if (t.startsWith("host") || t.startsWith("srflx") || t.startsWith("prflx")) return html`<${Badge} tone="ok" title="浏览器与 UE 直连">直连<//>`;
	return html`<${Badge}>${t.split("→")[0]}<//>`;
};
const useProgramName = () => {
	const programs = useStore().overview?.programs || [];
	return [programs, (id) => programs.find((x) => x.id === id)?.name || id];
};

function Live() {
	const s = useStore();
	const [programs, pname] = useProgramName();
	const [filter, setFilter] = useState("");
	const players = (s.overview?.players || []).filter((p) => !filter || p.programId === filter);
	const kick = async (p) => (await confirmDialog({ title: "断开观众", text: `确定断开观众 ${p.ip}？其页面会提示已被管理员断开。`, okText: "断开" })) && run(() => api("POST", `/sessions/${p.id}/kick`), "已断开");
	return html`<${Card}
		title=${`实时观众（${players.length}）`}
		sub="码率、画面、延迟由观众浏览器每 5 秒上报一次"
		extra=${html`<select class="sm" value=${filter} onChange=${(e) => setFilter(e.target.value)}><option value="">全部程序</option>${programs.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>`}
	>
		<${Table}
			rows=${players}
			empty="当前没有观众"
			columns=${[
				{ title: "观众", render: (p) => html`<b>${p.ip}</b> ${p.external ? html`<${Badge} tone="info">外网<//>` : html`<${Badge}>内网<//>`}<div class="muted small ellipsis" title=${p.userAgent}>${p.userAgent}</div>` },
				{ title: "程序", render: (p) => pname(p.programId) },
				{ title: "状态", render: (p) => html`<${StateBadge} state=${p.state} />${p.vip ? html` <${Badge} tone="accent" title="使用 VIP 访问链接">VIP<//>` : ""}${p.state === "queued" ? html`<div class="muted small">第 ${p.queuePos} 位</div>` : ""}` },
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
	const [programs, pname] = useProgramName();
	const [q, setQ] = useState({ program: "", ip: "", offset: 0 });
	const limit = 50;
	const qs = `program=${encodeURIComponent(q.program)}&ip=${encodeURIComponent(q.ip)}`;
	const list = usePoll(() => api("GET", `/sessions/history?limit=${limit}&offset=${q.offset}&${qs}`), [q.program, q.ip, q.offset]);
	const d = list.data || { total: 0, rows: [] };
	return html`<${Card}
		title=${`历史会话（${fmt.num(d.total)}）`}
		extra=${html`<select class="sm" value=${q.program} onChange=${(e) => setQ({ ...q, program: e.target.value, offset: 0 })}><option value="">全部程序</option>${programs.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
			<input class="sm" placeholder="IP 包含…（回车）" value=${q.ip} onChange=${(e) => setQ({ ...q, ip: e.target.value.trim(), offset: 0 })} />
			<button class="ghost sm" disabled=${!d.total} onClick=${() => download(`/sessions/export?${qs}`)} title="按当前筛选导出（最多 10 万条），Excel 可直接打开">导出 CSV</button>`}
	>
		<${Table}
			rows=${list.data ? d.rows : null}
			loading=${list.loading}
			empty="暂无记录"
			columns=${[
				{ title: "开始", render: (r) => fmt.time(r.started_at) },
				{ title: "时长", render: (r) => fmt.dur((r.ended_at || Date.now()) - r.started_at) },
				{ title: "程序", render: (r) => pname(r.program_id) },
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
			<span class="muted small">${d.total ? `${q.offset + 1}-${Math.min(d.total, q.offset + limit)} / ${fmt.num(d.total)}` : ""}</span>
			<button class="ghost sm" disabled=${q.offset + limit >= d.total} onClick=${() => setQ({ ...q, offset: q.offset + limit })}>下一页</button>
		</div>
	<//>`;
}

function Stats() {
	const [, pname] = useProgramName();
	const [days, setDays] = useState(7);
	const st = usePoll(() => api("GET", `/sessions/stats?days=${days}`), [days]);
	const rows = [...(st.data?.programs || [])].sort((a, b) => b.total_ms - a.total_ms);
	const total = rows.reduce((a, r) => ({ s: a.s + r.sessions, ms: a.ms + (r.total_ms || 0) }), { s: 0, ms: 0 });
	return html`<${Card}
		title="使用统计"
		sub=${rows.length ? `合计 ${fmt.num(total.s)} 次会话 · 累计观看 ${fmt.dur(total.ms)}` : ""}
		extra=${html`<div class="seg">${[1, 7, 30, 90].map((d) => html`<button class=${days === d ? "on" : ""} onClick=${() => setDays(d)}>${d} 天</button>`)}</div>`}
	>
		<${Table}
			rows=${st.data ? rows : null}
			loading=${st.loading}
			rowKey=${(r) => r.program_id}
			empty="该时间段内没有会话"
			columns=${[
				{ title: "程序", render: (r) => html`${pname(r.program_id)}<div class="muted small">${r.program_id}</div>` },
				{ title: "会话数", render: (r) => fmt.num(r.sessions) },
				{ title: "外网会话", render: (r) => fmt.num(r.external) },
				{ title: "累计观看时长", render: (r) => fmt.dur(r.total_ms) },
				{ title: "平均时长", render: (r) => fmt.dur(r.sessions ? r.total_ms / r.sessions : 0) },
			]}
		/>
	<//>`;
}
