import { html, usePoll, api, run, Card, Table, Badge, Modal, Field, fmt, can, useState, copyText, useStore } from "../lib.js";

const BASE_KEY = "ps.publicBaseUrl";

export function Links() {
	const list = usePoll(() => api("GET", "/share-links"), []);
	const s = useStore();
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState(null);
	const [base, setBase] = useState(localStorage.getItem(BASE_KEY) || "");
	const saveBase = (v) => {
		setBase(v);
		localStorage.setItem(BASE_KEY, v.replace(/\/+$/, ""));
	};
	const revoke = (l) => run(() => api("POST", `/share-links/${l.id}/revoke`), "已作废").then(list.reload);
	const status = (l) =>
		l.revoked ? html`<${Badge} tone="bad">已作废<//>` : l.expires_at && l.expires_at < Date.now() ? html`<${Badge}>已过期<//>` : l.max_uses && l.uses >= l.max_uses ? html`<${Badge}>次数用完<//>` : html`<${Badge} tone="ok">有效<//>`;
	return html`
		<${Card} title="对外访问地址">
			<${Field} label="公网访问前缀" hint="nginx 对外的地址（含映射端口），仅用于拼接完整链接，保存在本浏览器。例如 https://stream.example.com:65443">
				<input value=${base} placeholder=${location.origin} onInput=${(e) => saveBase(e.target.value)} />
			<//>
		<//>
		<${Card} title="访问链接" extra=${can("operator") && html`<button class="primary" onClick=${() => setCreating(true)}>生成链接</button>`}>
			<p class="muted small">程序开启「需要访问链接」后，观众必须使用这里生成的链接访问；链接可设置有效期与可用次数，可随时作废。</p>
			<${Table}
				rows=${list.data}
				empty="还没有生成过链接"
				columns=${[
					{ title: "程序", key: "program_id" },
					{ title: "备注", key: "note" },
					{ title: "状态", render: status },
					{ title: "使用", render: (l) => `${l.uses}${l.max_uses ? ` / ${l.max_uses}` : ""}` },
					{ title: "到期", render: (l) => (l.expires_at ? fmt.time(l.expires_at) : "不限") },
					{ title: "创建", render: (l) => html`${fmt.time(l.created_at)}<div class="muted small">${l.created_by}</div>` },
					{ title: "", class: "actions", render: (l) => can("operator") && !l.revoked && html`<button class="danger sm" onClick=${() => revoke(l)}>作废</button>` },
				]}
			/>
		<//>
		${creating &&
		html`<${CreateModal}
			programs=${s.overview?.programs || []}
			onClose=${() => setCreating(false)}
			onCreated=${(l) => {
				setCreating(false);
				setCreated(l);
				list.reload();
			}}
		/>`}
		${created &&
		html`<${Modal} title="链接已生成" onClose=${() => setCreated(null)} footer=${html`<button class="primary" onClick=${() => setCreated(null)}>完成</button>`}>
			<p>请复制下面的链接发给观众（只显示这一次）：</p>
			<pre class="code wrap">${(base || location.origin) + created.path}</pre>
			<button class="primary" onClick=${() => copyText((base || location.origin) + created.path)}>复制链接</button>
		<//>`}
	`;
}

function CreateModal({ programs, onClose, onCreated }) {
	const [programId, setProgram] = useState(programs.find((p) => p.enabled)?.id || "");
	const [hours, setHours] = useState(24);
	const [maxUses, setMaxUses] = useState(0);
	const [note, setNote] = useState("");
	const submit = async () => {
		const l = await run(() => api("POST", "/share-links", { programId, hours: +hours || 0, maxUses: +maxUses || 0, note }));
		if (l) onCreated(l);
	};
	return html`<${Modal} title="生成访问链接" onClose=${onClose} footer=${html`<button class="ghost" onClick=${onClose}>取消</button><button class="primary" onClick=${submit} disabled=${!programId}>生成</button>`}>
		<${Field} label="程序"><select value=${programId} onChange=${(e) => setProgram(e.target.value)}>${programs.map((p) => html`<option value=${p.id}>${p.name}（${p.id}）</option>`)}</select><//>
		<${Field} label="有效期（小时）" hint="0 = 永不过期"><input type="number" min="0" value=${hours} onInput=${(e) => setHours(e.target.value)} /><//>
		<${Field} label="可用次数" hint="每次打开计 1 次，0 = 不限"><input type="number" min="0" value=${maxUses} onInput=${(e) => setMaxUses(e.target.value)} /><//>
		<${Field} label="备注"><input value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="例如 某客户演示" /><//>
	<//>`;
}
