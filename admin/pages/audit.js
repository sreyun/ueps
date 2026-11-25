import { html, usePoll, api, Card, Table, fmt, useState } from "../lib.js";

const ACTIONS = {
	"auth.login": "登录",
	"auth.login_failed": "登录失败",
	"auth.change_password": "修改口令",
	"program.create": "新建程序",
	"program.update": "修改程序",
	"program.delete": "删除程序",
	"instance.start": "启动实例",
	"instance.stop": "停止实例",
	"instance.drain": "排空实例",
	"machine.update": "修改机器",
	"machine.delete": "删除机器",
	"agent.rotate_token": "轮换 Agent 令牌",
	"session.kick": "断开观众",
	"share.create": "生成访问链接",
	"share.revoke": "作废访问链接",
	"user.create": "新建用户",
	"user.update": "修改用户",
	"user.delete": "删除用户",
	"settings.update": "修改系统设置",
};

export function Audit() {
	const [offset, setOffset] = useState(0);
	const limit = 100;
	const list = usePoll(() => api("GET", `/audit?limit=${limit}&offset=${offset}`), [offset], 15000);
	const rows = list.data || [];
	return html`<${Card} title="审计日志">
		<${Table}
			rows=${rows}
			empty="暂无记录"
			columns=${[
				{ title: "时间", render: (r) => fmt.time(r.ts) },
				{ title: "用户", render: (r) => r.username || "-" },
				{ title: "来源 IP", key: "ip" },
				{ title: "操作", render: (r) => html`<span class=${r.action.endsWith("failed") ? "text-bad" : ""}>${ACTIONS[r.action] || r.action}</span>` },
				{ title: "对象", render: (r) => r.target || "-" },
				{ title: "详情", class: "wrap", render: (r) => (r.detail ? html`<code class="small">${r.detail.length > 160 ? r.detail.slice(0, 160) + "…" : r.detail}</code>` : "-") },
			]}
		/>
		<div class="pager">
			<button class="ghost sm" disabled=${offset === 0} onClick=${() => setOffset(Math.max(0, offset - limit))}>上一页</button>
			<button class="ghost sm" disabled=${rows.length < limit} onClick=${() => setOffset(offset + limit)}>下一页</button>
		</div>
	<//>`;
}
