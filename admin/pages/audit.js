import { html, usePoll, api, Card, Table, fmt, useState } from "../lib.js";

const ACTIONS = {
	"auth.login": "登录",
	"auth.login_failed": "登录失败",
	"auth.logout_all": "退出所有设备",
	"auth.change_password": "修改口令",
	"auth.totp_enable": "开启两步验证",
	"auth.totp_disable": "关闭两步验证",
	"program.create": "新建程序",
	"program.update": "修改程序",
	"program.delete": "删除程序",
	"instance.start": "启动实例",
	"instance.stop": "停止实例",
	"instance.drain": "排空实例",
	"machine.update": "修改渲染机",
	"machine.delete": "删除渲染机",
	"agent.rotate_token": "轮换 Agent 令牌",
	"session.kick": "断开观众",
	"session.export": "导出会话",
	"share.create": "生成访问链接",
	"share.revoke": "作废访问链接",
	"user.create": "新建用户",
	"user.update": "修改用户",
	"user.delete": "删除用户",
	"user.force_logout": "强制下线",
	"user.reset_password_cli": "命令行重置口令",
	"api_token.create": "新建 API 令牌",
	"api_token.revoke": "吊销 API 令牌",
	"settings.update": "修改系统设置",
	"backup.export": "导出配置",
	"backup.restore": "导入配置",
};

export function Audit() {
	const [offset, setOffset] = useState(0);
	const [q, setQ] = useState("");
	const limit = 100;
	const list = usePoll(() => api("GET", `/audit?limit=${limit}&offset=${offset}&q=${encodeURIComponent(q)}`), [offset, q], 15000);
	const rows = list.data || [];
	return html`<${Card}
		title="审计日志"
		sub="所有管理操作与登录记录，按保留天数自动清理"
		extra=${html`<input class="sm" placeholder="搜索用户 / 操作 / 对象 / IP（回车）" value=${q} onChange=${(e) => (setQ(e.target.value.trim()), setOffset(0))} />`}
	>
		<${Table}
			rows=${list.data ? rows : null}
			loading=${list.loading}
			empty=${q ? "没有匹配的记录" : "暂无记录"}
			columns=${[
				{ title: "时间", render: (r) => fmt.time(r.ts) },
				{ title: "用户", render: (r) => r.username || "-" },
				{ title: "来源 IP", key: "ip" },
				{ title: "操作", render: (r) => html`<span class=${r.action.endsWith("failed") ? "text-bad" : ""} title=${r.action}>${ACTIONS[r.action] || r.action}</span>` },
				{ title: "对象", render: (r) => r.target || "-" },
				{ title: "详情", class: "wrap", render: (r) => (r.detail ? html`<code class="small" title=${r.detail}>${r.detail.length > 160 ? r.detail.slice(0, 160) + "…" : r.detail}</code>` : "-") },
			]}
		/>
		<div class="pager">
			<button class="ghost sm" disabled=${offset === 0} onClick=${() => setOffset(Math.max(0, offset - limit))}>上一页</button>
			<span class="muted small">${rows.length ? `第 ${offset + 1}-${offset + rows.length} 条` : ""}</span>
			<button class="ghost sm" disabled=${rows.length < limit} onClick=${() => setOffset(offset + limit)}>下一页</button>
		</div>
	<//>`;
}
