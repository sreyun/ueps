import { html, usePoll, api, run, Card, Table, Badge, Modal, Field, fmt, can, useState, useStore, confirmDialog, CopyLine, AsyncButton, Empty, publicUrl, hasPublicBase, embedCode, copyText } from "../lib.js";

const linkState = (l) => (l.revoked ? "revoked" : l.expires_at && l.expires_at < Date.now() ? "expired" : l.max_uses && l.uses >= l.max_uses ? "used" : "ok");
const STATE = { revoked: ["bad", "已作废"], expired: ["muted", "已过期"], used: ["muted", "次数用完"], ok: ["ok", "有效"] };

export function Links() {
	const list = usePoll(() => api("GET", "/share-links"), []);
	const s = useStore();
	const [creating, setCreating] = useState(false);
	const [shown, setShown] = useState(null);
	const [onlyValid, setOnlyValid] = useState(true);
	const programs = s.overview?.programs || [];
	const pname = (id) => programs.find((p) => p.id === id)?.name || id;
	const revoke = async (l) => {
		if (!(await confirmDialog({ title: "作废访问链接", text: `作废后，正在使用该链接的观众刷新页面即无法再进入。确定作废「${l.note || l.id}」？`, okText: "作废" }))) return;
		if (await run(() => api("POST", `/share-links/${l.id}/revoke`), "已作废")) list.reload();
	};
	const copyAgain = async (l) => {
		const r = await run(() => api("POST", `/share-links/${l.id}/url`));
		if (r?.path) setShown({ ...l, path: r.path });
	};
	const rows = (list.data || []).filter((l) => !onlyValid || linkState(l) === "ok");
	return html`
		<${Card}
			title="访问链接"
			sub="程序开启「需要访问链接」后，观众必须使用这里生成的链接；可设置有效期与可用次数，随时作废。VIP 链接的观众排队优先。"
			extra=${html`<label class="check small"><input type="checkbox" checked=${onlyValid} onChange=${(e) => setOnlyValid(e.target.checked)} />只看有效</label>
				${can("operator") && html`<button class="primary" disabled=${!programs.length} onClick=${() => setCreating(true)}>＋ 生成链接</button>`}`}
		>
			${!hasPublicBase() && html`<div class="alert info">尚未设置「对外访问地址」，生成的链接将使用当前管理口地址（外网观众无法访问）。${can("admin") ? html` <a href="#/settings">去设置</a>` : ""}</div>`}
			<${Table}
				rows=${list.data ? rows : null}
				loading=${list.loading}
				empty=${html`<${Empty} action=${can("operator") && programs.length > 0 && html`<button class="primary" onClick=${() => setCreating(true)}>生成链接</button>`}>${onlyValid && list.data?.length ? "没有有效的链接（取消勾选「只看有效」查看全部）" : "还没有生成过链接"}<//>`}
				columns=${[
					{ title: "程序", render: (l) => html`${pname(l.program_id)}<div class="muted small">${l.program_id}</div>` },
					{ title: "备注", class: "wrap", render: (l) => html`${l.vip ? html`<${Badge} tone="accent" title="排队优先；程序开启「VIP 链接满员时抢占」时可让出普通观众的位置">VIP<//> ` : ""}${l.note || (l.vip ? "" : html`<span class="muted">—</span>`)}` },
					{ title: "状态", render: (l) => html`<${Badge} tone=${STATE[linkState(l)][0]}>${STATE[linkState(l)][1]}<//>` },
					{ title: "使用", render: (l) => `${l.uses}${l.max_uses ? ` / ${l.max_uses}` : ""}` },
					{ title: "到期", render: (l) => (l.expires_at ? fmt.time(l.expires_at) : "永不过期") },
					{ title: "创建", render: (l) => html`${fmt.time(l.created_at)}<div class="muted small">${l.created_by}</div>` },
					{
						title: "",
						class: "actions",
						render: (l) =>
							can("operator") &&
							linkState(l) === "ok" &&
							html`<button class="ghost sm" onClick=${() => copyAgain(l)}>复制链接</button><button class="danger sm" onClick=${() => revoke(l)}>作废</button>`,
					},
				]}
			/>
		<//>
		${creating &&
		html`<${CreateModal}
			programs=${programs}
			onClose=${() => setCreating(false)}
			onCreated=${(l) => {
				setCreating(false);
				setShown(l);
				list.reload();
			}}
		/>`}
		${shown && html`<${LinkModal} l=${shown} name=${pname(shown.program_id)} onClose=${() => setShown(null)} />`}
	`;
}

function LinkModal({ l, name, onClose }) {
	const url = publicUrl(l.path);
	const legacy = publicUrl(`/video.html?urlPrefix=${encodeURIComponent(l.program_id)}&token=${new URL(l.path, location.origin).searchParams.get("token")}`);
	return html`<${Modal} wide title=${`访问链接：${name}`} onClose=${onClose} footer=${html`<button class="primary" onClick=${onClose}>完成</button>`}>
		<p class="muted small">把链接发给观众即可观看${l.expires_at ? `，${fmt.time(l.expires_at)} 前有效` : ""}${l.max_uses ? `，最多 ${l.max_uses} 位观众使用（同一观众刷新不重复计数）` : ""}。之后也可以在列表中再次复制。</p>
		<${CopyLine} label="访问链接" value=${url} />
		<${CopyLine} label="企业版兼容" value=${legacy} />
		<h4>嵌入代码</h4>
		<pre class="code">${embedCode(legacy)}</pre>
		<button class="ghost sm" onClick=${() => copyText(embedCode(legacy))}>复制嵌入代码</button>
	<//>`;
}

function CreateModal({ programs, onClose, onCreated }) {
	const real = programs.filter((p) => p.id !== "default");
	const preferred = real.find((p) => p.enabled && p.require_token) || real.find((p) => p.enabled) || programs.find((p) => p.enabled) || programs[0];
	const [programId, setProgram] = useState(preferred?.id || "");
	const [hours, setHours] = useState(24);
	const [maxUses, setMaxUses] = useState(0);
	const [note, setNote] = useState("");
	const [vip, setVip] = useState(false);
	const prog = programs.find((p) => p.id === programId);
	const submit = async () => {
		const l = await run(() => api("POST", "/share-links", { programId, hours: Math.max(0, +hours || 0), maxUses: Math.max(0, Math.floor(+maxUses) || 0), note: note.trim(), vip }));
		if (l?.path) onCreated(l);
	};
	return html`<${Modal} title="生成访问链接" onClose=${onClose} footer=${html`<button class="ghost" onClick=${onClose}>取消</button><${AsyncButton} class="primary" onClick=${submit} disabled=${!programId}>生成<//>`}>
		<${Field} label="程序" hint=${prog && !prog.require_token ? "该程序未开启「需要访问链接」，任何人都能直接访问；链接仍可用于统计来源" : ""}>
			<select value=${programId} onChange=${(e) => setProgram(e.target.value)}>${programs.map((p) => html`<option value=${p.id}>${p.name}（${p.id}）${p.require_token ? " · 需链接" : ""}</option>`)}</select>
		<//>
		<div class="row3">
			<${Field} label="有效期（小时）" hint="0 = 永不过期"><input type="number" min="0" value=${hours} onInput=${(e) => setHours(e.target.value)} /><//>
			<${Field} label="可用人数" hint="0 = 不限；同一观众刷新不计"><input type="number" min="0" value=${maxUses} onInput=${(e) => setMaxUses(e.target.value)} /><//>
		</div>
		<${Field} label="备注"><input value=${note} maxlength="200" onInput=${(e) => setNote(e.target.value)} placeholder="例如 某客户演示" /><//>
		<label class="check"><input type="checkbox" checked=${vip} onChange=${(e) => setVip(e.target.checked)} /> VIP 链接：使用该链接的观众排队优先；程序满员时可断开观看时间最长的普通观众让出位置（取决于程序的「VIP 链接满员时抢占」设置）</label>
	<//>`;
}
