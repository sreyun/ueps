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
	const res = await fetch(`/api/v1${path}`, {
		method,
		credentials: "same-origin",
		headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-PS-Request": "1" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	let data = null;
	try {
		data = await res.json();
	} catch {}
	if (res.status === 401 && path !== "/auth/login") store.set({ user: null });
	if (!res.ok) throw new ApiError(res.status, data?.error || `请求失败 (${res.status})`);
	return data;
}

/* ------------------------------------------------------------------ 全局状态 */
export const store = {
	state: { user: undefined, overview: null, connected: false },
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

/** 实时推送：/api/v1/events，断线自动重连 */
let eventsWs = null;
export function connectEvents() {
	if (eventsWs && eventsWs.readyState <= 1) return;
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	eventsWs = new WebSocket(`${proto}//${location.host}/api/v1/events`);
	eventsWs.onopen = () => store.set({ connected: true });
	eventsWs.onmessage = (e) => {
		const m = JSON.parse(e.data);
		if (m.type === "overview") store.set({ overview: { ...(store.state.overview || {}), ...m.data } });
	};
	eventsWs.onclose = () => {
		store.set({ connected: false });
		if (store.state.user) setTimeout(connectEvents, 2000);
	};
}
export function disconnectEvents() {
	if (eventsWs) {
		eventsWs.onclose = null;
		eventsWs.close();
		eventsWs = null;
	}
}

/** 周期拉取数据的 hook */
export function usePoll(fn, deps = [], intervalMs = 0) {
	const [state, setState] = useState({ data: null, error: null, loading: true });
	const reload = async () => {
		try {
			const data = await fn();
			setState({ data, error: null, loading: false });
		} catch (e) {
			setState((s) => ({ ...s, error: e.message, loading: false }));
		}
	};
	useEffect(() => {
		reload();
		if (!intervalMs) return;
		const t = setInterval(reload, intervalMs);
		return () => clearInterval(t);
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

/* ------------------------------------------------------------------ 通知 */
export function toast(text, tone = "ok") {
	store.set({ toasts: [...(store.state.toasts || []), { id: Math.random(), text, tone }] });
	setTimeout(() => store.set({ toasts: (store.state.toasts || []).slice(1) }), 3500);
}
export async function run(fn, okText) {
	try {
		const r = await fn();
		if (okText) toast(okText);
		return r;
	} catch (e) {
		toast(e.message, "bad");
		throw e;
	}
}

/* ------------------------------------------------------------------ 组件 */
export const Badge = ({ tone = "muted", children }) => html`<span class="badge ${tone}">${children}</span>`;
export const StateBadge = ({ state }) => html`<${Badge} tone=${STATE_TONE[state] || "muted"}>${STATE_LABEL[state] || state}<//>`;

export function Card({ title, extra, children, class: cls = "" }) {
	return html`<section class="card ${cls}">
		${(title || extra) && html`<header class="card-h"><h3>${title}</h3><div class="card-x">${extra}</div></header>`}
		<div class="card-b">${children}</div>
	</section>`;
}

export function Kpi({ label, value, sub, tone = "" }) {
	return html`<div class="kpi ${tone}"><div class="kpi-l">${label}</div><div class="kpi-v">${value}</div>${sub && html`<div class="kpi-s">${sub}</div>`}</div>`;
}

export function Bar({ value, max = 100, tone }) {
	const pct = max ? Math.min(100, Math.round((100 * (value || 0)) / max)) : 0;
	const t = tone || (pct > 90 ? "bad" : pct > 70 ? "warn" : "ok");
	return html`<div class="bar"><i class=${t} style=${`width:${pct}%`}></i></div>`;
}

export function Empty({ children = "暂无数据" }) {
	return html`<div class="empty">${children}</div>`;
}

export function Table({ columns, rows, empty, rowKey = (r) => r.id }) {
	if (!rows?.length) return html`<${Empty}>${empty}<//>`;
	return html`<div class="table-wrap"><table>
		<thead><tr>${columns.map((c) => html`<th class=${c.class || ""}>${c.title}</th>`)}</tr></thead>
		<tbody>${rows.map((r) => html`<tr key=${rowKey(r)}>${columns.map((c) => html`<td class=${c.class || ""}>${c.render ? c.render(r) : r[c.key] ?? "-"}</td>`)}</tr>`)}</tbody>
	</table></div>`;
}

export function Modal({ title, onClose, children, footer, wide }) {
	useEffect(() => {
		const k = (e) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", k);
		return () => window.removeEventListener("keydown", k);
	}, []);
	return html`<div class="modal-bg" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
		<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
			<header><h3>${title}</h3><button class="icon" onClick=${onClose} aria-label="关闭">✕</button></header>
			<div class="modal-b">${children}</div>
			${footer && html`<footer>${footer}</footer>`}
		</div>
	</div>`;
}

export function confirmDialog(text) {
	return window.confirm(text);
}

export function Field({ label, hint, children, error }) {
	return html`<label class="field"><span class="field-l">${label}</span>${children}${error ? html`<span class="field-e">${error}</span>` : hint && html`<span class="field-h">${hint}</span>`}</label>`;
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

export function copyText(text) {
	navigator.clipboard?.writeText(text).then(
		() => toast("已复制"),
		() => toast("复制失败，请手动复制", "warn")
	);
}
