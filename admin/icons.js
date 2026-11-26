// 管理端图标：24×24 线性图标（自绘，无第三方资源），颜色随文字（currentColor）
import { html } from "./vendor/preact-htm.js";

const P = {
	dashboard: () => html`<rect x="3" y="3" width="7.5" height="9" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6" /><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6" /><rect x="3" y="15" width="7.5" height="6" rx="1.6" />`,
	viewers: () => html`<rect x="2.5" y="4" width="19" height="13" rx="2.2" /><path d="M8 21h8M12 17v4" /><path d="M10.2 8.3v5.4l4.6-2.7z" />`,
	program: () => html`<path d="M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4z" /><path d="M3.8 7.6 12 12l8.2-4.4M12 12v9" />`,
	instance: () => html`<rect x="5" y="5" width="14" height="14" rx="2.2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9.5 2v3M14.5 2v3M9.5 19v3M14.5 19v3M2 9.5h3M2 14.5h3M19 9.5h3M19 14.5h3" />`,
	server: () => html`<rect x="3" y="3.5" width="18" height="7" rx="2" /><rect x="3" y="13.5" width="18" height="7" rx="2" /><path d="M7 7h.01M7 17h.01M11 7h2M11 17h2" />`,
	link: () => html`<path d="M10 13.6a4.5 4.5 0 0 0 6.6.3l2.9-2.9a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3" /><path d="M14 10.4a4.5 4.5 0 0 0-6.6-.3L4.5 13a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3" />`,
	settings: () => html`<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1" /><circle cx="15" cy="6.5" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="17.5" r="2" />`,
	users: () => html`<circle cx="9" cy="8" r="3.6" /><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0" /><path d="M15.5 4.6a3.6 3.6 0 0 1 0 6.8M17.8 14.3a6.5 6.5 0 0 1 3.7 6.2" />`,
	terminal: () => html`<rect x="2.5" y="4" width="19" height="16" rx="2.2" /><path d="m7 9.5 2.8 2.5L7 14.5M12.5 14.5h4.5" />`,
	shield: () => html`<path d="M12 2.6 4.2 5.6v5.8c0 4.9 3.3 8.5 7.8 10 4.5-1.5 7.8-5.1 7.8-10V5.6z" /><path d="m8.6 12 2.4 2.4 4.4-4.8" />`,
	copy: () => html`<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2.2" /><path d="M15.5 8.5V5.2A2.2 2.2 0 0 0 13.3 3H5.2A2.2 2.2 0 0 0 3 5.2v8.1a2.2 2.2 0 0 0 2.2 2.2h3.3" />`,
	check: () => html`<path d="m4.5 12.5 4.8 4.8L19.5 7" />`,
	eye: () => html`<path d="M2.2 12S5.8 5 12 5s9.8 7 9.8 7-3.6 7-9.8 7-9.8-7-9.8-7z" /><circle cx="12" cy="12" r="3" />`,
	eyeOff: () => html`<path d="m3 3 18 18" /><path d="M10.6 5.1Q11.3 5 12 5c6.2 0 9.8 7 9.8 7a17 17 0 0 1-3.1 4.1M6.6 6.6A17 17 0 0 0 2.2 12S5.8 19 12 19a9.6 9.6 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />`,
	download: () => html`<path d="M12 3.5v11.5M7 10l5 5 5-5M4 20h16" />`,
	upload: () => html`<path d="M12 15.5V4M7 9l5-5 5 5M4 20h16" />`,
	refresh: () => html`<path d="M20.5 11a8.5 8.5 0 0 0-14.9-4.6L3.5 8.5M3.5 4v4.5H8M3.5 13a8.5 8.5 0 0 0 14.9 4.6l2.1-2.1M20.5 20v-4.5H16" />`,
	plus: () => html`<path d="M12 5v14M5 12h14" />`,
	x: () => html`<path d="M6 6l12 12M18 6 6 18" />`,
	chevronDown: () => html`<path d="m6 9 6 6 6-6" />`,
	external: () => html`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />`,
	alert: () => html`<path d="M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4.5M12 17.2h.01" />`,
	info: () => html`<circle cx="12" cy="12" r="9.3" /><path d="M12 11v5.5M12 7.6h.01" />`,
	checkCircle: () => html`<circle cx="12" cy="12" r="9.3" /><path d="m8 12.3 2.8 2.7L16 9.5" />`,
	xCircle: () => html`<circle cx="12" cy="12" r="9.3" /><path d="m9 9 6 6M15 9l-6 6" />`,
	sun: () => html`<circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />`,
	moon: () => html`<path d="M20.3 14.6A8.4 8.4 0 1 1 9.4 3.7a6.8 6.8 0 0 0 10.9 10.9z" />`,
	monitor: () => html`<rect x="2.5" y="4" width="19" height="13" rx="2.2" /><path d="M8 21h8M12 17v4" />`,
	menu: () => html`<path d="M4 6.5h16M4 12h16M4 17.5h16" />`,
	logout: () => html`<path d="M9.5 21H5.2A2.2 2.2 0 0 1 3 18.8V5.2A2.2 2.2 0 0 1 5.2 3h4.3M16 16.5 20.5 12 16 7.5M20.5 12H9" />`,
	user: () => html`<circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />`,
	key: () => html`<circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8M17.2 5.8l2.8 2.8M14.6 8.4l2 2" />`,
	globe: () => html`<circle cx="12" cy="12" r="9.3" /><path d="M2.7 12h18.6M12 2.7c2.5 2.6 3.8 5.8 3.8 9.3s-1.3 6.7-3.8 9.3c-2.5-2.6-3.8-5.8-3.8-9.3S9.5 5.3 12 2.7z" />`,
	activity: () => html`<path d="M2.5 12h4l3-7.5 5 15 3-7.5h4" />`,
	layers: () => html`<path d="m12 3 9.5 5-9.5 5-9.5-5z" /><path d="m2.5 12.5 9.5 5 9.5-5" /><path d="m2.5 16.5 9.5 5 9.5-5" opacity=".55" />`,
	trash: () => html`<path d="M4 7h16M10 11v6M14 11v6M5.5 7l.9 12.2A2 2 0 0 0 8.4 21h7.2a2 2 0 0 0 2-1.8L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />`,
	edit: () => html`<path d="M4 20h4L19.3 8.7a2.3 2.3 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />`,
	lock: () => html`<rect x="4" y="10.5" width="16" height="10.5" rx="2.2" /><path d="M8 10.5V7.2a4 4 0 0 1 8 0v3.3" />`,
	play: () => html`<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" />`,
	search: () => html`<circle cx="11" cy="11" r="7" /><path d="m20.5 20.5-4.5-4.5" />`,
	clock: () => html`<circle cx="12" cy="12" r="9.3" /><path d="M12 7v5l3.2 2" />`,
	gpu: () => html`<rect x="2.5" y="6" width="19" height="11" rx="2" /><circle cx="9" cy="11.5" r="2.6" /><path d="M14.5 9.5h3.5M14.5 13.5h3.5M6 17v2.5M10 17v2.5M14 17v2.5" />`,
	wifi: () => html`<path d="M2.5 8.8a14 14 0 0 1 19 0M5.5 12.2a9.5 9.5 0 0 1 13 0M8.6 15.5a5 5 0 0 1 6.8 0M12 19h.01" />`,
	windows: () => html`<path fill="currentColor" stroke="none" d="M3 5.6 10.4 4.5v7H3zM11.6 4.3 21 3v8.5h-9.4zM3 12.5h7.4v7L3 18.4zM11.6 12.5H21V21l-9.4-1.3z" />`,
	box: () => html`<path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" />`,
	more: () => html`<circle cx="5.5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18.5" cy="12" r="1.2" fill="currentColor" />`,
};

/** <${Icon} name="copy" size=${16} /> */
export function Icon({ name, size = 16, class: cls = "", title }) {
	const body = P[name] && P[name]();
	if (!body) return null;
	return html`<svg class=${"ico " + cls} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden=${title ? undefined : "true"} role=${title ? "img" : undefined}>${title && html`<title>${title}</title>`}${body}</svg>`;
}

/** 品牌标识：播放三角 + 数据流 */
export function Logo({ size = 28 }) {
	return html`<svg class="logo" width=${size} height=${size} viewBox="0 0 32 32" aria-hidden="true">
		<defs><linearGradient id="lg-brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b9bff" /><stop offset="1" stop-color="#2563eb" /></linearGradient></defs>
		<rect width="32" height="32" rx="8" fill="url(#lg-brand)" />
		<path d="M12.2 9.6v12.8a.9.9 0 0 0 1.4.8l9.9-6.4a.9.9 0 0 0 0-1.6l-9.9-6.4a.9.9 0 0 0-1.4.8z" fill="#fff" />
		<path d="M6.5 12.5h3M6.5 16h3M6.5 19.5h3" stroke="#fff" stroke-opacity=".6" stroke-width="1.6" stroke-linecap="round" />
	</svg>`;
}
