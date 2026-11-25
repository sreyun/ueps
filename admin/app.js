// 管理端入口：登录、布局、路由
import { html, render } from "./vendor/preact-htm.js";
import { api, store, useStore, connectEvents, disconnectEvents, useState, useEffect, toast, Field, ROLE_LABEL, can } from "./lib.js";
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
	{ path: "/", label: "概览", icon: "◎", page: Dashboard, role: "viewer" },
	{ path: "/instances", label: "实例", icon: "▣", page: Instances, role: "viewer" },
	{ path: "/programs", label: "程序", icon: "◇", page: Programs, role: "viewer" },
	{ path: "/machines", label: "机器 / GPU", icon: "▤", page: Machines, role: "viewer" },
	{ path: "/sessions", label: "观众会话", icon: "◉", page: Sessions, role: "viewer" },
	{ path: "/links", label: "访问链接", icon: "⛓", page: Links, role: "viewer" },
	{ path: "/users", label: "用户", icon: "☺", page: Users, role: "admin" },
	{ path: "/settings", label: "系统设置", icon: "⚙", page: Settings, role: "admin" },
	{ path: "/logs", label: "运行日志", icon: "≣", page: Logs, role: "admin" },
	{ path: "/audit", label: "审计日志", icon: "☰", page: Audit, role: "admin" },
];

function useRoute() {
	const get = () => location.hash.replace(/^#/, "") || "/";
	const [r, setR] = useState(get());
	useEffect(() => {
		const f = () => setR(get());
		window.addEventListener("hashchange", f);
		return () => window.removeEventListener("hashchange", f);
	}, []);
	return r;
}

function Login() {
	const [u, setU] = useState("admin");
	const [p, setP] = useState("");
	const [code, setCode] = useState("");
	const [needCode, setNeedCode] = useState(false);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (e) => {
		e.preventDefault();
		setBusy(true);
		setErr("");
		try {
			const res = await fetch("/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-PS-Request": "1" },
				body: JSON.stringify({ username: u, password: p, code: needCode ? code : undefined }),
			});
			const r = await res.json();
			if (res.status === 401 && r.totpRequired) return setNeedCode(true); // 第二步：输入两步验证码
			if (!res.ok) throw new Error(r.error || "登录失败");
			store.set({ user: r.user, mustChangePassword: r.mustChangePassword });
			if (r.mustChangePassword) location.hash = "#/account";
		} catch (e2) {
			setErr(e2.message);
			if (needCode) setCode("");
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="login">
		<form class="login-card" onSubmit=${submit}>
			<div class="brand big"><b>▶</b> 云渲染管理平台</div>
			<p class="muted">UE 像素流 · 实例调度 · 零 UDP 映射对外服务</p>
			<${Field} label="用户名"><input autocomplete="username" value=${u} onInput=${(e) => setU(e.target.value)} required /><//>
			<${Field} label="口令"><input type="password" autocomplete="current-password" value=${p} onInput=${(e) => setP(e.target.value)} required autofocus /><//>
			${needCode &&
			html`<${Field} label="两步验证码" hint="打开手机验证器 App 查看 6 位动态码">
				<input inputmode="numeric" autocomplete="one-time-code" maxlength="6" value=${code} onInput=${(e) => setCode(e.target.value.replace(/\D/g, ""))} autofocus required />
			<//>`}
			${err && html`<div class="alert bad">${err}</div>`}
			<button class="primary block" disabled=${busy}>${busy ? "登录中…" : "登录"}</button>
			<p class="muted small">首次部署的初始口令保存在数据目录的 initial-admin.txt 中。</p>
		</form>
	</div>`;
}

function Layout({ route }) {
	const s = useStore();
	const item = NAV.find((n) => n.path === route) || (route === "/account" ? { label: "账户", page: Account, role: "viewer" } : NAV[0]);
	const Page = can(item.role) ? item.page : () => html`<div class="alert warn">没有访问该页面的权限</div>`;
	const k = s.overview?.kpis;
	const logout = async () => {
		await api("POST", "/auth/logout").catch(() => {});
		disconnectEvents();
		store.set({ user: null, overview: null });
	};
	return html`<div class="shell">
		<aside class="side">
			<div class="brand"><b>▶</b> 云渲染管理平台</div>
			<nav>
				${NAV.filter((n) => can(n.role)).map(
					(n) => html`<a href=${"#" + n.path} class=${route === n.path ? "on" : ""}><i>${n.icon}</i>${n.label}
						${n.path === "/sessions" && k?.queued ? html`<em class="pill warn">${k.queued}</em>` : ""}</a>`
				)}
			</nav>
			<div class="side-foot">
				<div class=${"live " + (s.connected ? "on" : "")}>${s.connected ? "实时连接正常" : "实时连接断开，重连中…"}</div>
			</div>
		</aside>
		<main class="main">
			<header class="top">
				<h1>${item.label}</h1>
				<div class="top-r">
					${s.mustChangePassword && html`<a class="pill warn" href="#/account">请修改初始口令</a>`}
					<a href="#/account" class="user">${s.user.username} · ${ROLE_LABEL[s.user.role]}</a>
					<button class="ghost" onClick=${logout}>退出</button>
				</div>
			</header>
			<div class="content"><${Page} /></div>
		</main>
	</div>`;
}

function Toasts() {
	const s = useStore();
	return html`<div class="toasts">${(s.toasts || []).map((t) => html`<div class="toast ${t.tone}" key=${t.id}>${t.text}</div>`)}</div>`;
}

function App() {
	const s = useStore();
	const route = useRoute();
	useEffect(() => {
		api("GET", "/auth/me")
			.then((r) => store.set({ user: r.user, mustChangePassword: r.mustChangePassword, version: r.version }))
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
	if (s.forbidden) return html`<div class="login"><div class="login-card"><div class="alert bad">${s.forbidden}</div><p class="muted">管理端只允许从配置的管理网段访问。</p></div></div>`;
	if (s.user === undefined) return html`<div class="boot">加载中…</div>`;
	return html`${s.user ? html`<${Layout} route=${route} />` : html`<${Login} />`}<${Toasts} />`;
}

render(html`<${App} />`, document.getElementById("app"));
window.addEventListener("unhandledrejection", (e) => e.reason?.message && toast(e.reason.message, "bad"));
