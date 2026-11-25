import { html, useStore, usePoll, api, Card, Kpi, Bar, LineChart, Table, Badge, fmt, useState } from "../lib.js";

export function Dashboard() {
	const s = useStore();
	const o = s.overview;
	const [range, setRange] = useState("1h");
	const series = usePoll(() => api("GET", `/stats/series?range=${range}`), [range], 10000);
	if (!o) return html`<div class="boot">加载中…</div>`;
	const k = o.kpis;
	const pts = series.data?.points || [];
	const rangeBtns = html`<div class="seg">${["1h", "24h"].map((r) => html`<button class=${range === r ? "on" : ""} onClick=${() => setRange(r)}>${r === "1h" ? "1 小时" : "24 小时"}</button>`)}</div>`;
	return html`
		<div class="kpis">
			<${Kpi} label="在线观众" value=${k.viewers} sub=${`外网 ${k.external} · 排队 ${k.queued}`} tone=${k.queued ? "warn" : ""} />
			<${Kpi} label="运行实例" value=${k.instances.active} sub=${`使用中 ${k.instances.busy} · 空闲 ${k.instances.idle} · 启动中 ${k.instances.starting}`} />
			<${Kpi} label="渲染机器" value=${`${k.machines.online} / ${k.machines.total}`} sub="在线 / 已登记" tone=${k.machines.total && !k.machines.online ? "bad" : ""} />
			<${Kpi}
				label="GPU"
				value=${k.gpu.count ? `${k.gpu.util ?? 0}%` : "-"}
				sub=${k.gpu.count ? `${k.gpu.count} 块 · 显存 ${fmt.mb(k.gpu.memUsedMB)} / ${fmt.mb(k.gpu.memTotalMB)}` : "未检测到 NVIDIA GPU"}
			/>
			<${Kpi}
				label="TURN 中继"
				value=${k.turn.up ? fmt.kbps(k.turn.kbps) : k.turn.enabled ? "离线" : "未启用"}
				sub=${k.turn.up ? `${k.turn.workers} 个进程 · ${k.turn.allocations} 个分配${k.turn.dropped ? ` · 拥塞丢包 ${fmt.num(k.turn.dropped)}` : ""}` : "外网观众经 nginx 同端口中继"}
				tone=${k.turn.enabled && !k.turn.up ? "bad" : ""}
			/>
		</div>
		<div class="grid2">
			<${Card} title="观众" extra=${rangeBtns}>
				<${LineChart} points=${pts} series=${[
					{ key: "viewers", label: "在线", color: "#4f8cff" },
					{ key: "external", label: "外网", color: "#a78bfa" },
					{ key: "queued", label: "排队", color: "#f59e0b" },
				]} />
			<//>
			<${Card} title="资源">
				<${LineChart}
					points=${pts}
					format=${(v) => Math.round(v)}
					series=${[
						{ key: "instances", label: "实例数", color: "#22c55e" },
						{ key: "gpu", label: "GPU %", color: "#ef4444" },
						{ key: "cpu", label: "CPU %", color: "#06b6d4" },
					]}
				/>
			<//>
		</div>
		<${Card} title="程序运行状态">
			<${Table}
				rows=${o.programs}
				empty="还没有程序，请到「程序」页面新建"
				columns=${[
					{ title: "程序", render: (p) => html`<b>${p.name}</b><div class="muted small">${p.id}</div>` },
					{ title: "状态", render: (p) => (p.enabled ? (p.lastError ? html`<${Badge} tone="bad">异常<//>` : html`<${Badge} tone="ok">正常<//>`) : html`<${Badge}>已停用<//>`) },
					{ title: "观众", render: (p) => html`${p.viewers}${p.queue ? html` <${Badge} tone="warn">排队 ${p.queue}<//>` : ""}` },
					{ title: "实例", render: (p) => html`${p.instances.total} / ${p.max_instances}<div class="muted small">使用 ${p.instances.busy} · 空闲 ${p.instances.idle} · 启动 ${p.instances.starting}</div>` },
					{ title: "模式", render: (p) => (p.mode === "shared" ? `共享（每实例 ${p.capacity} 人）` : "独占") },
					{ title: "最近问题", class: "wrap", render: (p) => (p.lastError ? html`<span class="text-bad">${p.lastError}</span>` : html`<span class="muted">—</span>`) },
				]}
			/>
		<//>
		<${Card} title="渲染机器">
			<${Table}
				rows=${o.machines}
				empty="还没有渲染节点接入，请到「机器 / GPU」页面查看接入方法"
				columns=${[
					{ title: "机器", render: (m) => html`<b>${m.name}</b><div class="muted small">${m.id}${m.local ? " · 本机" : ""}</div>` },
					{ title: "状态", render: (m) => (m.online ? html`<${Badge} tone="ok">在线<//>` : html`<${Badge} tone="bad">离线<//>`) },
					{ title: "CPU", render: (m) => (m.online ? html`<${Bar} value=${m.cpu} />${m.cpu}%` : "-") },
					{ title: "内存", render: (m) => (m.online && m.memTotalMB ? html`<${Bar} value=${m.memUsedMB} max=${m.memTotalMB} />${fmt.mb(m.memUsedMB)} / ${fmt.mb(m.memTotalMB)}` : "-") },
					{ title: "GPU", render: (m) => (m.gpus?.length ? m.gpus.map((g) => html`<div class="gpu-mini">#${g.index} ${g.util ?? "-"}% · ${fmt.mb(g.memUsedMB)}/${fmt.mb(g.memTotalMB)}</div>`) : html`<span class="muted">-</span>`) },
					{ title: "进程", render: (m) => m.procs?.length || 0 },
				]}
			/>
		<//>
	`;
}
