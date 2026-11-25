// 管理端公共库：API、全局状态、格式化、通用组件
import { html, useState, useEffect, useRef, useMemo } from "./vendor/preact-htm.js";
export { html, useState, useEffect, useRef, useMemo };

/* ------------------------------------------------------------------ API */
export class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}
export async function api(method, path, body) {
	let res;
	try {
		res = await fetch(`/api/v1${path}`, {
			method,
			credentials: "same-origin",
			headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-PS-Request": "1" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch {
		throw new ApiError(0, "无法连接平台，请检查网络或平台是否在运行");
	}
	let data = null;
	try {
		data = await res.json();
	} catch {}
	if (res.status === 401 && path !== "/auth/login" && store.state.user) store.set({ user: null, overview: null, sessionExpired: true });
	if (!res.ok) throw new ApiError(res.status, data?.error || `请求失败 (${res.status})`);
	return data;
}

/* ------------------------------------------------------------------ 全局状态 */
export const store = {
	state: { user: undefined, overview: null, connected: false, publicBaseUrl: "" },
	subs: new Set(),
	set(patch) {
		this.state = { ...this.state, ...patch };
		for (const fn of this.subs) fn(this.state);
	},
};
export function useStore() {
	const [, force] = useState(0);
	useEffect(() => {
		const fn = () => force((n) => n + 1);
		store.subs.add(fn);
		return () => store.subs.delete(fn);
	}, []);
	return store.state;
}

/** 实时推送：/api/v1/events，断线自动重连（退避到 10 秒） */
let eventsWs = null;
let retry = 0;
export function connectEvents() {
	if (eventsWs && eventsWs.readyState <= 1) return;
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	eventsWs = new WebSocket(`${proto}//${location.host}/api/v1/events`);
	eventsWs.onopen = () => {
		retry = 0;
		store.set({ connected: true });
	};
	eventsWs.onmessage = (e) => {
		let m;
		try {
			m = JSON.parse(e.data);
		} catch {
			return;
		}
		if (m.type === "overview") store.set({ overview: { ...(store.state.overview || {}), ...m.data } });
	};
	eventsWs.onclose = (e) => {
		store.set({ connected: false });
		if (e.code === 4401) return store.set({ user: null, overview: null, sessionExpired: true }); // 会话失效（改口令/被强制下线）
		if (store.state.user) setTimeout(connectEvents, Math.min(10000, 1000 * 2 ** retry++));
	};
}
export function disconnectEvents() {
	if (eventsWs) {
		eventsWs.onclose = null;
		eventsWs.close();
		eventsWs = null;
	}
}

/** 周期拉取数据的 hook（页面不可见时暂停轮询） */
export function usePoll(fn, deps = [], intervalMs = 0) {
	const [state, setState] = useState({ data: null, error: null, loading: true });
	const alive = useRef(true);
	const reload = async () => {
		try {
			const data = await fn();
			if (alive.current) setState({ data, error: null, loading: false });
		} catch (e) {
			if (alive.current) setState((s) => ({ ...s, error: e.message, loading: false }));
		}
	};
	useEffect(() => {
		alive.current = true;
		reload();
		if (!intervalMs) return () => (alive.current = false);
		const t = setInterval(() => !document.hidden && reload(), intervalMs);
		return () => {
			alive.current = false;
			clearInterval(t);
		};
	}, deps);
	return { ...state, reload };
}

/* ------------------------------------------------------------------ 格式化 */
export const fmt = {
	num: (n) => (n === null || n === undefined ? "-" : Number(n).toLocaleString()),
	mb: (mb) => (mb === null || mb === undefined ? "-" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`),
	kbps: (k) => (k === null || k === undefined ? "-" : k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`),
	dur(ms) {
		if (!ms || ms < 0) return "-";
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s} 秒`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m} 分 ${s % 60} 秒`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h} 小时 ${m % 60} 分`;
		return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
	},
	since: (t) => (t ? fmt.dur(Date.now() - t) : "-"),
	time: (t) => (t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "-"),
	clock: (t) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }),
};

export const STATE_LABEL = { starting: "启动中", ready: "就绪", busy: "使用中", idle: "空闲", stopping: "停止中", failed: "失败", playing: "播放中", queued: "排队中" };
export const STATE_TONE = { starting: "info", ready: "ok", busy: "accent", idle: "ok", stopping: "muted", failed: "bad", playing: "accent", queued: "warn" };
export const ROLE_LABEL = { admin: "管理员", operator: "运维", viewer: "只读" };
const RANK = { viewer: 1, operator: 2, admin: 3 };
/** 当前用户是否具备某角色 */
export const can = (role) => (RANK[store.state.user?.role] || 0) >= RANK[role];

/* ------------------------------------------------------------------ 对外地址 / 嵌入代码 */
/** 观众访问的完整地址：优先"系统设置 → 对外访问地址"，未设置时退回当前页面地址（管理口，仅内网可用） */
export function publicUrl(path) {
	const base = (store.state.publicBaseUrl || "").replace(/\/+$/, "") || location.origin;
	return base + path;
}
export const hasPublicBase = () => !!store.state.publicBaseUrl;
export const playPath = (id, token) => `/play/${encodeURIComponent(id)}${token ? `?token=${token}` : ""}`;
export const legacyPath = (id, token) => `/video.html?urlPrefix=${encodeURIComponent(id)}${token ? `&token=${token}` : ""}`;
export const embedCode = (url) => `<iframe src="${url}"\n        allow="autoplay; fullscreen; clipboard-read; clipboard-write"\n        style="border:0;width:100%;height:100%"></iframe>`;

/* ------------------------------------------------------------------ 通知 */
let toastSeq = 0;
export function toast(text, tone = "ok") {
	const id = ++toastSeq;
	store.set({ toasts: [...(store.state.toasts || []), { id, text, tone }].slice(-4) });
	setTimeout(() => dismissToast(id), tone === "bad" ? 6000 : 3500);
}
export const dismissToast = (id) => store.set({ toasts: (store.state.toasts || []).filter((t) => t.id !== id) });
/** 执行操作：成功提示 okText，失败弹出错误（返回 undefined，不抛出） */
export async function run(fn, okText) {
	try {
		const r = await fn();
		if (okText) toast(okText);
		return r ?? true;
	} catch (e) {
		toast(e.message, "bad");
		return undefined;
	}
}

/* ------------------------------------------------------------------ 确认对话框（替代 window.confirm） */
/** await confirmDialog("文本") 或 confirmDialog({ title, text, okText, danger }) → true / false */
export function confirmDialog(opts) {
	const o = typeof opts === "string" ? { text: opts } : opts;
	return new Promise((resolve) => store.set({ confirm: { title: "请确认", okText: "确定", danger: true, ...o, resolve } }));
}
export function ConfirmHost() {
	const s = useStore();
	const c = s.confirm;
	if (!c) return null;
	const done = (v) => {
		store.set({ confirm: null });
		c.resolve(v);
	};
	return html`<${Modal}
		title=${c.title}
		onClose=${() => done(false)}
		footer=${html`<button class="ghost" onClick=${() => done(false)}>取消</button><button class=${c.danger ? "danger solid" : "primary"} onClick=${() => done(true)} autofocus>${c.okText}</button>`}
	>
		<p class="confirm-text">${c.text}</p>
	<//>`;
}

/* ------------------------------------------------------------------ 组件 */
export const Badge = ({ tone = "muted", children, title }) => html`<span class="badge ${tone}" title=${title}>${children}</span>`;
export const StateBadge = ({ state }) => html`<${Badge} tone=${STATE_TONE[state] || "muted"}>${STATE_LABEL[state] || state}<//>`;

export function Card({ title, extra, children, class: cls = "", sub }) {
	return html`<section class="card ${cls}">
		${(title || extra) &&
		html`<header class="card-h">
			<div><h3>${title}</h3>${sub && html`<div class="card-sub">${sub}</div>`}</div>
			<div class="card-x">${extra}</div>
		</header>`}
		<div class="card-b">${children}</div>
	</section>`;
}

export function Kpi({ label, value, sub, tone = "", href }) {
	const body = html`<div class="kpi-l">${label}</div><div class="kpi-v">${value}</div>${sub && html`<div class="kpi-s">${sub}</div>`}`;
	return href ? html`<a class="kpi link ${tone}" href=${href}>${body}</a>` : html`<div class="kpi ${tone}">${body}</div>`;
}

export function Bar({ value, max = 100, tone }) {
	const pct = max ? Math.min(100, Math.round((100 * (value || 0)) / max)) : 0;
	const t = tone || (pct > 90 ? "bad" : pct > 70 ? "warn" : "ok");
	return html`<div class="bar"><i class=${t} style=${`width:${pct}%`}></i></div>`;
}

export function Empty({ children = "暂无数据", action }) {
	return html`<div class="empty"><div>${children}</div>${action && html`<div class="empty-a">${action}</div>`}</div>`;
}

export function Table({ columns, rows, empty, rowKey = (r) => r.id, loading }) {
	if (loading && !rows) return html`<div class="empty"><span class="spin"></span> 加载中…</div>`;
	if (!rows?.length) return typeof empty === "object" && empty?.type ? empty : html`<${Empty}>${empty}<//>`;
	return html`<div class="table-wrap"><table>
		<thead><tr>${columns.map((c) => html`<th class=${c.class || ""}>${c.title}</th>`)}</tr></thead>
		<tbody>${rows.map((r) => html`<tr key=${rowKey(r)}>${columns.map((c) => html`<td class=${c.class || ""} data-label=${c.title}><div class="cell">${c.render ? c.render(r) : r[c.key] ?? "-"}</div></td>`)}</tr>`)}</tbody>
	</table></div>`;
}

export function Modal({ title, onClose, children, footer, wide, onSubmit }) {
	useEffect(() => {
		const k = (e) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", k);
		document.body.classList.add("modal-open");
		return () => {
			window.removeEventListener("keydown", k);
			if (!document.querySelector(".modal-bg ~ .modal-bg")) document.body.classList.remove("modal-open");
		};
	}, []);
	const body = html`
		<header><h3>${title}</h3><button type="button" class="icon" onClick=${onClose} aria-label="关闭">✕</button></header>
		<div class="modal-b">${children}</div>
		${footer && html`<footer>${footer}</footer>`}`;
	return html`<div class="modal-bg" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
		${onSubmit
			? html`<form class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" onSubmit=${(e) => (e.preventDefault(), onSubmit())}>${body}</form>`
			: html`<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${body}</div>`}
	</div>`;
}

/** 异步按钮：执行期间禁用并显示进度，防止重复提交 */
export function AsyncButton({ onClick, children, class: cls = "", disabled, type = "button", title }) {
	const [busy, setBusy] = useState(false);
	const click = async (e) => {
		if (busy) return;
		if (type === "submit") return; // 交给表单 onSubmit
		setBusy(true);
		try {
			await onClick?.(e);
		} finally {
			setBusy(false);
		}
	};
	return html`<button type=${type} class=${cls} disabled=${disabled || busy} onClick=${click} title=${title}>${busy && html`<span class="spin"></span>`}${children}</button>`;
}

/** 选项卡 */
export function Tabs({ tabs, value, onChange }) {
	return html`<div class="tabs" role="tablist">
		${tabs.map(([k, label, badge]) => html`<button type="button" role="tab" class=${value === k ? "on" : ""} aria-selected=${value === k} onClick=${() => onChange(k)}>${label}${badge ? html` <em>${badge}</em>` : ""}</button>`)}
	</div>`;
}

export function Field({ label, hint, children, error, class: cls = "" }) {
	return html`<label class="field ${cls}"><span class="field-l">${label}</span>${children}${error ? html`<span class="field-e">${error}</span>` : hint && html`<span class="field-h">${hint}</span>`}</label>`;
}

/** 可复制的一行文本 */
export function CopyLine({ value, label }) {
	return html`<div class="copyline">${label && html`<span class="copyline-l">${label}</span>`}<code title=${value}>${value}</code><button type="button" class="ghost sm" onClick=${() => copyText(value)}>复制</button></div>`;
}

/** 受控表单状态 */
export function useForm(initial) {
	const [v, setV] = useState(initial);
	const bind = (k, kind = "text") => {
		if (kind === "checkbox") return { checked: !!v[k], onChange: (e) => setV({ ...v, [k]: e.target.checked }) };
		if (kind === "number") return { value: v[k] ?? "", type: "number", onInput: (e) => setV({ ...v, [k]: e.target.value === "" ? "" : Number(e.target.value) }) };
		return { value: v[k] ?? "", onInput: (e) => setV({ ...v, [k]: e.target.value }) };
	};
	return [v, setV, bind];
}

/** 轻量折线图（SVG，无依赖）。series: [{ key, label, color }] */
export function LineChart({ points = [], series, height = 160, format = (v) => v }) {
	const ref = useRef(null);
	const [w, setW] = useState(600);
	const [hover, setHover] = useState(null);
	useEffect(() => {
		const ro = new ResizeObserver((e) => setW(Math.max(200, e[0].contentRect.width)));
		if (ref.current) ro.observe(ref.current);
		return () => ro.disconnect();
	}, []);
	const pad = { l: 44, r: 10, t: 10, b: 22 };
	const iw = w - pad.l - pad.r;
	const ih = height - pad.t - pad.b;
	const max = Math.max(1, ...points.flatMap((p) => series.map((s) => p[s.key] || 0)));
	const niceMax = (() => {
		const pow = 10 ** Math.floor(Math.log10(max));
		return Math.ceil(max / pow) * pow;
	})();
	const x = (i) => pad.l + (points.length > 1 ? (i / (points.length - 1)) * iw : iw / 2);
	const y = (v) => pad.t + ih - ((v || 0) / niceMax) * ih;
	const ticks = [0, 0.5, 1].map((f) => niceMax * f);
	const onMove = (e) => {
		if (!points.length) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const i = Math.round(((e.clientX - rect.left - pad.l) / iw) * (points.length - 1));
		setHover(Math.max(0, Math.min(points.length - 1, i)));
	};
	return html`<div class="chart" ref=${ref}>
		${!points.length
			? html`<${Empty}>正在收集数据（每 10 秒一个点）<//>`
			: html`<svg width=${w} height=${height} onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
					${ticks.map((t) => html`<g><line x1=${pad.l} x2=${w - pad.r} y1=${y(t)} y2=${y(t)} class="grid" /><text x=${pad.l - 6} y=${y(t) + 4} text-anchor="end" class="tick">${format(t)}</text></g>`)}
					${series.map(
						(s) => html`<path d=${points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join("")} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" />`
					)}
					<text x=${pad.l} y=${height - 4} class="tick">${fmt.clock(points[0].t)}</text>
					<text x=${w - pad.r} y=${height - 4} text-anchor="end" class="tick">${fmt.clock(points[points.length - 1].t)}</text>
					${hover !== null &&
					html`<g><line x1=${x(hover)} x2=${x(hover)} y1=${pad.t} y2=${pad.t + ih} class="cursor" />
						${series.map((s) => html`<circle cx=${x(hover)} cy=${y(points[hover][s.key])} r="3.5" fill=${s.color} />`)}</g>`}
				</svg>
				<div class="legend">
					${series.map((s) => html`<span><i style=${`background:${s.color}`}></i>${s.label}${hover !== null ? `：${format(points[hover][s.key] || 0)}` : ""}</span>`)}
					${hover !== null && html`<span class="muted">${fmt.clock(points[hover].t)}</span>`}
				</div>`}
	</div>`;
}

/** 复制到剪贴板：http 访问管理端时 navigator.clipboard 不可用，退回 execCommand */
export function copyText(text) {
	const fallback = () => {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
		document.body.appendChild(ta);
		ta.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {}
		ta.remove();
		ok ? toast("已复制") : toast("复制失败，请手动选中复制", "warn");
	};
	if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast("已复制"), fallback);
	else fallback();
}

/** 下载文件（带会话 Cookie） */
export function download(path) {
	const a = document.createElement("a");
	a.href = `/api/v1${path}`;
	a.rel = "noopener";
	document.body.appendChild(a);
	a.click();
	a.remove();
}
