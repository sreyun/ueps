// 管理端入口：登录、布局、路由
import { html, render } from "./vendor/preact-htm.js";
import { api, store, useStore, connectEvents, disconnectEvents, useState, useEffect, toast, dismissToast, Field, ROLE_LABEL, can, ConfirmHost } from "./lib.js";
import { Dashboard } from "./pages/dashboard.js";
import { Instances } from "./pages/instances.js";
import { Programs } from "./pages/programs.js";
import { Machines } from "./pages/machines.js";
import { Sessions } from "./pages/sessions.js";
import { Links } from "./pages/links.js";
import { Users } from "./pages/users.js";
import { Settings } from "./pages/settings.js";
import { Audit } from "./pages/audit.js";
import { Account } from "./pages/account.js";
import { Logs } from "./pages/logs.js";

const NAV = [
	{
		group: "运营",
		items: [
			{ path: "/", label: "概览", icon: "◎", page: Dashboard, role: "viewer", desc: "观众、实例、机器与链路的实时状态" },
			{ path: "/sessions", label: "观众会话", icon: "◉", page: Sessions, role: "viewer", desc: "在线观众的播放质量、历史记录与使用统计" },
		],
	},
	{
		group: "资源",
		items: [
			{ path: "/programs", label: "程序与访问", icon: "◇", page: Programs, role: "viewer", desc: "UE 应用的启动、调度与访问方式（播放地址 / 嵌入代码）" },
			{ path: "/instances", label: "实例", icon: "▣", page: Instances, role: "viewer", desc: "正在运行的 UE 进程，平台按需自动启停" },
			{ path: "/machines", label: "渲染机 / GPU", icon: "▤", page: Machines, role: "viewer", desc: "渲染节点、GPU 负载与接入方法" },
			{ path: "/links", label: "访问链接", icon: "⛓", page: Links, role: "viewer", desc: "带有效期、次数限制的观众访问链接" },
		],
	},
	{
		group: "系统",
		items: [
			{ path: "/settings", label: "系统设置", icon: "⚙", page: Settings, role: "admin", desc: "对外地址、播放链路、安全、告警、API 令牌与备份" },
			{ path: "/users", label: "用户", icon: "☺", page: Users, role: "admin", desc: "管理端账号与角色" },
			{ path: "/logs", label: "运行日志", icon: "≣", page: Logs, role: "admin", desc: "平台、调度与 TURN 的实时日志" },
			{ path: "/audit", label: "审计日志", icon: "☰", page: Audit, role: "admin", desc: "所有管理操作的记录" },
		],
	},
];
const ALL = NAV.flatMap((g) => g.items);
const ACCOUNT = { path: "/account", label: "我的账户", page: Account, role: "viewer", desc: "口令、两步验证与登录会话" };

function useRoute() {
	const get = () => (location.hash.replace(/^#/, "") || "/").split("?")[0];
	const [r, setR] = useState(get());
	useEffect(() => {
		const f = () => setR(get());
		window.addEventListener("hashchange", f);
		return () => window.removeEventListener("hashchange", f);
	}, []);
	return r;
}

function Login() {
	const s = useStore();
	const [u, setU] = useState(localStorage.getItem("ps.lastUser") || "admin");
	const [p, setP] = useState("");
	const [code, setCode] = useState("");
	const [needCode, setNeedCode] = useState(false);
	const [err, setErr] = useState(s.sessionExpired ? "登录已过期或已在其它地方退出，请重新登录" : "");
	const [busy, setBusy] = useState(false);
	const submit = async (e) => {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		setErr("");
		try {
			const res = await fetch("/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-PS-Request": "1" },
				body: JSON.stringify({ username: u.trim(), password: p, code: needCode ? code : undefined }),
			});
			const r = await res.json().catch(() => ({}));
			if (res.status === 401 && r.totpRequired) return setNeedCode(true); // 第二步：输入两步验证码
			if (!res.ok) throw new Error(r.error || `登录失败（${res.status}）`);
			localStorage.setItem("ps.lastUser", u.trim());
			const me = await api("GET", "/auth/me");
			store.set({ user: me.user, mustChangePassword: me.mustChangePassword, version: me.version, publicBaseUrl: me.publicBaseUrl, sessionExpired: false });
			if (me.mustChangePassword) location.hash = "#/account";
		} catch (e2) {
			setErr(e2.message === "Failed to fetch" ? "无法连接平台，请检查网络" : e2.message);
			if (needCode) setCode("");
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="login">
		<form class="login-card" onSubmit=${submit}>
			<div class="brand big"><b>▶</b> 云渲染管理平台</div>
			<p class="muted login-sub">UE 像素流 · 实例调度 · 单端口对外服务</p>
			${needCode
				? html`<${Field} label="两步验证码" hint="打开手机验证器 App，输入 ${u} 的 6 位动态码">
						<input inputmode="numeric" autocomplete="one-time-code" maxlength="6" value=${code} onInput=${(e) => setCode(e.target.value.replace(/\D/g, ""))} autofocus required />
					<//>`
				: html`<${Field} label="用户名"><input autocomplete="username" value=${u} onInput=${(e) => setU(e.target.value)} required /><//>
						<${Field} label="口令"><input type="password" autocomplete="current-password" value=${p} onInput=${(e) => setP(e.target.value)} required autofocus /><//>`}
			${err && html`<div class="alert bad">${err}</div>`}
			<button class="primary block" disabled=${busy || (needCode && code.length !== 6)}>${busy ? "登录中…" : needCode ? "验证" : "登录"}</button>
			${needCode && html`<button type="button" class="ghost block" onClick=${() => (setNeedCode(false), setCode(""), setErr(""))}>返回</button>`}
			<p class="muted small login-foot">首次部署的初始口令在数据目录的 initial-admin.txt 中；忘记口令可在服务器执行 <code>--reset-password admin</code>。</p>
		</form>
	</div>`;
}

/** 需要关注的问题：实时连接断开、初始口令、TURN 异常、渲染机全部离线、程序异常 */
function HealthBanner() {
	const s = useStore();
	const k = s.overview?.kpis;
	const items = [];
	if (!s.connected && s.overview) items.push(["warn", "与平台的实时连接已断开，数据可能不是最新的，正在自动重连…"]);
	if (s.mustChangePassword) items.push(["warn", html`当前账户仍在使用初始口令，<a href="#/account">请立即修改</a>。`]);
	if (k?.turn && k.turn.enabled && !k.turn.up) items.push(["bad", "内置 TURN 未运行：外网观众将无法播放。请查看「运行日志」中的 [turn] 记录。"]);
	if (k?.machines?.total && !k.machines.online) items.push(["bad", html`所有渲染机都已离线，新观众无法进入。<a href="#/machines">查看渲染机</a>`]);
	const broken = (s.overview?.programs || []).filter((p) => p.enabled && p.lastError);
	if (broken.length) items.push(["warn", html`${broken.length} 个程序最近启动异常：${broken.map((p) => p.name).join("、")}。<a href="#/programs">查看详情</a>`]);
	if (!items.length) return null;
	return html`<div class="banners">${items.map(([tone, text]) => html`<div class="banner ${tone}">${text}</div>`)}</div>`;
}

function Layout({ route }) {
	const s = useStore();
	const [menu, setMenu] = useState(false);
	const [userMenu, setUserMenu] = useState(false);
	const item = ALL.find((n) => n.path === route) || (route === "/account" ? ACCOUNT : ALL[0]);
	const Page = can(item.role) ? item.page : () => html`<div class="alert warn">当前账户没有访问该页面的权限</div>`;
	const k = s.overview?.kpis;
	useEffect(() => setMenu(false), [route]);
	useEffect(() => {
		document.title = `${item.label} · 云渲染管理平台`;
	}, [item]);
	const logout = async () => {
		await api("POST", "/auth/logout").catch(() => {});
		disconnectEvents();
		store.set({ user: null, overview: null, sessionExpired: false });
	};
	return html`<div class=${"shell" + (menu ? " menu-open" : "")}>
		<aside class="side">
			<div class="brand"><b>▶</b> 云渲染管理平台</div>
			<nav>
				${NAV.map((g) => {
					const items = g.items.filter((n) => can(n.role));
					return (
						items.length > 0 &&
						html`<div class="nav-group">${g.group}</div>
							${items.map(
								(n) => html`<a href=${"#" + n.path} class=${route === n.path ? "on" : ""}><i>${n.icon}</i>${n.label}
									${n.path === "/sessions" && k?.queued ? html`<em class="pill warn" title="排队人数">${k.queued}</em>` : ""}
									${n.path === "/machines" && k?.machines?.total && k.machines.online < k.machines.total ? html`<em class="pill bad" title="离线渲染机">${k.machines.total - k.machines.online}</em>` : ""}</a>`
							)}`
					);
				})}
			</nav>
			<div class="side-foot">
				<div class=${"live " + (s.connected ? "on" : "")}>${s.connected ? "实时连接正常" : "实时连接断开，重连中…"}</div>
				${s.version && html`<div class="muted">v${s.version}</div>`}
			</div>
		</aside>
		<div class="scrim" onClick=${() => setMenu(false)}></div>
		<main class="main">
			<header class="top">
				<button class="icon menu-btn" onClick=${() => setMenu(!menu)} aria-label="菜单">☰</button>
				<div class="top-title">
					<h1>${item.label}</h1>
					<div class="top-desc">${item.desc}</div>
				</div>
				<div class="top-r">
					${k && html`<span class="top-stat" title="在线观众 / 排队">◉ ${k.viewers}${k.queued ? html` <span class="text-warn">· 排队 ${k.queued}</span>` : ""}</span>`}
					<div class="user-menu">
						<button class="ghost" onClick=${() => setUserMenu(!userMenu)} onBlur=${() => setTimeout(() => setUserMenu(false), 150)}>${s.user.username} <span class="muted">· ${ROLE_LABEL[s.user.role]}</span> ▾</button>
						${userMenu &&
						html`<div class="dropdown">
							<a href="#/account">我的账户</a>
							<a href=${s.publicBaseUrl ? s.publicBaseUrl + "/" : "/?portal"} target="_blank" rel="noopener">打开观众门户</a>
							<button onClick=${logout}>退出登录</button>
						</div>`}
					</div>
				</div>
			</header>
			<div class="content">
				<${HealthBanner} />
				<${Page} key=${route} />
			</div>
		</main>
	</div>`;
}

function Toasts() {
	const s = useStore();
	return html`<div class="toasts" aria-live="polite">${(s.toasts || []).map((t) => html`<div class="toast ${t.tone}" key=${t.id} onClick=${() => dismissToast(t.id)} title="点击关闭">${t.text}</div>`)}</div>`;
}

function App() {
	const s = useStore();
	const route = useRoute();
	useEffect(() => {
		api("GET", "/auth/me")
			.then((r) => store.set({ user: r.user, mustChangePassword: r.mustChangePassword, version: r.version, publicBaseUrl: r.publicBaseUrl }))
			.catch((e) => {
				store.set({ user: null });
				if (e.status === 403) store.set({ forbidden: e.message });
			});
	}, []);
	useEffect(() => {
		if (s.user) {
			connectEvents();
			api("GET", "/overview").then((o) => store.set({ overview: o }), () => {});
		}
	}, [s.user?.id]);
	if (s.forbidden) return html`<div class="login"><div class="login-card"><div class="alert bad">${s.forbidden}</div><p class="muted">管理端只允许从配置的管理网段访问（config.json → security.adminAllow）。</p></div></div>`;
	if (s.user === undefined) return html`<div class="boot"><span class="spin"></span> 加载中…</div>`;
	return html`${s.user ? html`<${Layout} route=${route} />` : html`<${Login} />`}<${ConfirmHost} /><${Toasts} />`;
}

render(html`<${App} />`, document.getElementById("app"));
window.addEventListener("unhandledrejection", (e) => e.reason?.message && toast(e.reason.message, "bad"));
