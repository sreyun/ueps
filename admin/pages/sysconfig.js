// 系统参数（原 config.json / 环境变量中的启动参数，注册表与校验见 src/config-center.js）：按分组呈现为紧凑的设置列表
import { html, api, run, Badge, useState, useEffect, confirmDialog, AsyncButton, Icon, Alert, toast } from "../lib.js";

/** 输入框中的显示形式 */
export const show = (it, v) => {
	if (it.type === "bool") return !!v;
	if (Array.isArray(v)) return v.join(it.type === "paths" ? "\n" : ", ");
	return v === null || v === undefined ? "" : String(v);
};
export const fmtVal = (it, v) => {
	if (it.type === "bool") return v ? "开启" : "关闭";
	if (it.type === "enum") return it.options.find((o) => o.value === v)?.label || v;
	if (Array.isArray(v)) return v.length ? v.join(it.type === "paths" ? "；" : ", ") : "（空）";
	return v === null || v === "" || v === undefined ? "（空）" : String(v);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const draftOf = (items) => Object.fromEntries(items.map((it) => [it.key, show(it, it.value)]));

function Control({ it, value, onChange }) {
	const dis = it.locked;
	if (it.type === "bool")
		return html`<label class="switch" title=${dis ? "由环境变量锁定" : ""}><input type="checkbox" role="switch" checked=${value} disabled=${dis} aria-label=${it.label} onChange=${(e) => onChange(e.target.checked)} /><span></span></label>`;
	if (it.type === "enum") return html`<select value=${value} disabled=${dis} aria-label=${it.label} onChange=${(e) => onChange(e.target.value)}>${it.options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}</select>`;
	if (it.type === "int") return html`<input class="num" type="number" min=${it.min} max=${it.max} value=${value} disabled=${dis} aria-label=${it.label} onInput=${(e) => onChange(e.target.value)} />`;
	if (it.type === "paths") return html`<textarea rows="2" value=${value} disabled=${dis} spellcheck="false" aria-label=${it.label} placeholder="每行一个完整路径，留空 = 不限制" onInput=${(e) => onChange(e.target.value)}></textarea>`;
	const ph = { cidrs: "IP 或网段，逗号分隔", ips: "IP，逗号分隔", listen: "127.0.0.1:3478", url: "留空 = 不提供一键获取", hostOrAuto: "auto", ipOrAuto: "auto", workers: "auto", optHostPort: "留空 = 不启用" }[it.type];
	return html`<input value=${value} disabled=${dis} spellcheck="false" aria-label=${it.label} placeholder=${ph || ""} onInput=${(e) => onChange(e.target.value)} />`;
}

function Row({ it, value, dirty, flash, onChange, onReset, restartTag = true }) {
	return html`<div class=${"set-row" + (dirty ? " dirty" : "") + (flash ? " flash" : "")} data-key=${it.key}>
		<div class="set-l">
			<div class="set-label">
				${it.label}
				${it.help && html`<span class="set-help" tabindex="0" title=${it.help} aria-label=${it.help}><${Icon} name="info" size=${13} /></span>`}
				${it.locked && html`<${Badge} tone="info" title=${`由环境变量 ${it.env} 设置，这里只读；删除该环境变量后沿用当前值`}><${Icon} name="lock" size=${11} />${it.env}<//>`}
				${it.pending && html`<${Badge} tone="warn" title=${`本次运行仍为：${fmtVal(it, it.bootValue)}`}>重启后生效<//>`}
				${restartTag && !it.pending && it.apply === "restart" && !it.locked && html`<span class="set-tag" title="保存后需重启平台才生效">需重启</span>`}
			</div>
			${(it.hint || (!it.locked && it.stored !== null && !same(it.value, it.default))) &&
			html`<div class="set-hint">
				${it.hint && html`<span>${it.hint}</span>`}
				${!it.locked && it.stored !== null && !same(it.value, it.default) && html`<button type="button" class="link" title=${`默认：${fmtVal(it, it.default)}`} onClick=${onReset}>恢复默认</button>`}
			</div>`}
		</div>
		<div class="set-c"><${Control} it=${it} value=${value} onChange=${onChange} /></div>
	</div>`;
}

/** 一个分组的系统参数：data = GET /config；onSaved(新的 data) */
export function ConfigSection({ data, group, onSaved, onDirty, highlight, stale, onReload }) {
	const items = data.items.filter((it) => it.group === group);
	const [draft, setDraft] = useState(() => draftOf(items));
	useEffect(() => setDraft(draftOf(items)), [data, group]);
	const changed = items.filter((it) => !it.locked && draft[it.key] !== show(it, it.value));
	const dirty = changed.length > 0;
	useEffect(() => onDirty?.(dirty), [dirty]);
	useEffect(() => {
		const warn = (e) => dirty && (e.preventDefault(), (e.returnValue = ""));
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	const done = (r, verb) => {
		const live = r.changes.filter((c) => c.apply === "live").length;
		const later = r.changes.length - live;
		onSaved(r);
		if (!r.changes.length) toast("没有需要保存的修改");
		else toast(`${verb}：${live ? `${live} 项已立即生效` : ""}${live && later ? "，" : ""}${later ? `${later} 项重启平台后生效` : ""}`, later ? "warn" : "ok");
	};
	const save = async () => {
		const r = await run(() => api("PUT", "/config", { rev: data.rev, values: Object.fromEntries(changed.map((it) => [it.key, draft[it.key]])) }));
		if (r && r !== true) done(r, "已保存");
	};
	const reset = async (it) => {
		if (!(await confirmDialog({ title: "恢复默认", text: `把「${it.label}」恢复为默认值：${fmtVal(it, it.default)}？${it.apply === "restart" ? "\n重启平台后生效。" : ""}`, okText: "恢复默认", danger: false }))) return;
		const r = await run(() => api("POST", "/config/reset", { rev: data.rev, keys: [it.key] }));
		if (r && r !== true) done(r, "已恢复默认");
	};
	const pending = items.filter((it) => it.pending);
	const allRestart = items.length > 1 && items.every((it) => it.apply === "restart");
	return html`
		${stale && dirty && html`<${Alert} tone="warn">其他管理员刚修改了这些参数，请先 <button class="link" onClick=${onReload}>刷新</button>。<//>`}
		${pending.length > 0 && html`<${Alert} tone="warn"><span title="Windows 服务：重启 ps-platform 服务；Docker：docker compose restart platform">${pending.map((it) => it.label).join("、")}：重启平台后生效</span><//>`}
		${data.warnings.filter((w) => items.some((it) => w.includes(it.key))).map((w) => html`<${Alert} tone="warn">${w}<//>`)}
		${allRestart && !pending.length && html`<div><span class="set-tag">本页参数修改后需重启平台</span></div>`}
		<div class="card set-list">${items.map((it) => html`<${Row} key=${it.key} it=${it} value=${draft[it.key]} dirty=${changed.includes(it)} flash=${highlight === it.key} restartTag=${!allRestart} onChange=${(v) => setDraft({ ...draft, [it.key]: v })} onReset=${() => reset(it)} />`)}</div>
		${dirty &&
		html`<div class="savebar">
			<span class="text-warn small">${changed.length} 项未保存</span>
			<button class="ghost" onClick=${() => setDraft(draftOf(items))}>撤销修改</button>
			<${AsyncButton} class="primary" onClick=${save}>保存<//>
		</div>`}
	`;
}

/** 启动参数（只读）：在「系统信息」中展示 */
export function BootstrapInfo({ data }) {
	const src = (b) => (b.source === "env" ? html`<${Badge} tone="info">环境变量 ${b.env}<//>` : b.source === "config.json" ? html`<${Badge}>config.json<//>` : html`<span class="faint small">默认</span>`);
	return html`<div class="card set-list">
		${data.bootstrap.map(
			(b) => html`<div class="set-row" key=${b.key}>
				<div class="set-l"><div class="set-label">${b.label} ${src(b)}</div></div>
				<div class="set-c"><code class="set-code">${b.value === "" || b.value == null ? "（默认）" : String(b.value)}</code></div>
			</div>`
		)}
	</div>
	<p class="faint small set-foot">在 config.json / 环境变量中修改，重启生效；<code>ps-platform --show-config</code> 列出全部参数与来源。${data.envSecrets.length > 0 ? ` 已固定密钥：${data.envSecrets.join("、")}。` : ""}</p>`;
}
