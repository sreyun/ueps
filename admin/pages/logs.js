import { html, api, Card, useState, useEffect, useRef, fmt } from "../lib.js";

const TONE = { debug: "muted", info: "", warn: "text-warn", error: "text-bad" };

export function Logs() {
	const [level, setLevel] = useState("info");
	const [q, setQ] = useState("");
	const [rows, setRows] = useState([]);
	const [follow, setFollow] = useState(true);
	const box = useRef(null);
	const cursor = useRef(0);

	useEffect(() => {
		let alive = true;
		cursor.current = 0;
		setRows([]);
		const load = async () => {
			try {
				const data = await api("GET", `/logs?level=${level}&q=${encodeURIComponent(q)}&after=${cursor.current}&limit=500`);
				if (!alive || !data.length) return;
				cursor.current = data[data.length - 1].seq;
				setRows((r) => [...r, ...data].slice(-2000));
			} catch {}
		};
		load();
		const t = setInterval(load, 2000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [level, q]);

	useEffect(() => {
		if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
	}, [rows, follow]);

	return html`<${Card}
		title="运行日志"
		extra=${html`
			<select class="sm" value=${level} onChange=${(e) => setLevel(e.target.value)}>
				<option value="debug">全部</option><option value="info">信息及以上</option><option value="warn">警告及以上</option><option value="error">仅错误</option>
			</select>
			<input class="sm" placeholder="关键字过滤" value=${q} onChange=${(e) => setQ(e.target.value.trim())} />
			<label class="check small"><input type="checkbox" checked=${follow} onChange=${(e) => setFollow(e.target.checked)} />自动滚动</label>`}
	>
		<p class="muted small">显示最近 3000 条（实时刷新）。完整日志按天保存在数据目录的 logs/ 下，默认保留 14 天。</p>
		<div class="logbox" ref=${box}>
			${rows.length
				? rows.map((r) => html`<div class=${"logline " + (TONE[r.level] || "")} key=${r.seq}><span class="muted">${fmt.time(r.t)}</span> <b>${r.level.toUpperCase()}</b> ${r.msg}</div>`)
				: html`<div class="empty">暂无日志</div>`}
		</div>
	<//>`;
}
