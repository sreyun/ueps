import { html, usePoll, api, run, Card, Table, Badge, Modal, Field, fmt, useState, confirmDialog, ROLE_LABEL, useStore, AsyncButton, Icon } from "../lib.js";

export function Users() {
	const list = usePoll(() => api("GET", "/users"), []);
	const me = useStore().user;
	const [editing, setEditing] = useState(null);
	const act = async (confirm, fn, ok) => {
		if (confirm && !(await confirmDialog(confirm))) return;
		if (await run(fn, ok)) list.reload();
	};
	const del = (u) => act({ title: "删除用户", text: `确定删除用户 ${u.username}？此操作不可撤销。`, okText: "删除" }, () => api("DELETE", `/users/${u.id}`), "已删除");
	const forceLogout = (u) => act({ title: "强制下线", text: `确定让 ${u.username} 所有设备上的登录立即失效？`, okText: "强制下线" }, () => api("POST", `/users/${u.id}/logout`), "已强制下线");
	const resetTotp = (u) => act({ title: "重置两步验证", text: `确定重置 ${u.username} 的两步验证？其下次登录只需口令，并应尽快重新开启。`, okText: "重置" }, () => api("PUT", `/users/${u.id}`, { resetTotp: true }), "已重置");
	const toggle = (u) => act(u.disabled ? null : { title: "禁用用户", text: `禁用后 ${u.username} 将立即被登出且无法登录。确定禁用？`, okText: "禁用" }, () => api("PUT", `/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? "已启用" : "已禁用");
	return html`
		<${Card} title="用户" sub="管理员：全部权限 · 运维：程序、实例、机器、会话、访问链接 · 只读：仅查看" extra=${html`<button class="primary" onClick=${() => setEditing({})}><${Icon} name="plus" />新建用户</button>`}>
			<${Table}
				rows=${list.data}
				loading=${list.loading}
				columns=${[
					{ title: "用户名", render: (u) => html`<b>${u.username}</b>${u.id === me.id ? html` <${Badge} tone="info">当前<//>` : ""}` },
					{ title: "角色", render: (u) => ROLE_LABEL[u.role] },
					{ title: "状态", render: (u) => html`${u.disabled ? html`<${Badge} tone="bad">已禁用<//>` : html`<${Badge} tone="ok">正常<//>`} ${u.totp ? html`<${Badge} tone="info">两步验证<//>` : html`<${Badge} title="建议开启两步验证">未开启两步验证<//>`}` },
					{ title: "最近登录", render: (u) => fmt.time(u.last_login_at) },
					{ title: "创建时间", render: (u) => fmt.time(u.created_at) },
					{
						title: "",
						class: "actions",
						render: (u) => html`<button class="ghost sm" onClick=${() => setEditing(u)}>编辑</button>
							${u.id !== me.id && html`<button class="ghost sm" onClick=${() => forceLogout(u)} title="让该用户所有设备上的登录立即失效">强制下线</button>`}
							${u.totp && html`<button class="ghost sm" onClick=${() => resetTotp(u)} title="用户丢失手机时使用">重置两步验证</button>`}
							${u.id !== me.id && html`<button class="ghost sm" onClick=${() => toggle(u)}>${u.disabled ? "启用" : "禁用"}</button><button class="danger sm" onClick=${() => del(u)}>删除</button>`}`,
					},
				]}
			/>
		<//>
		${editing && html`<${Editor} u=${editing} self=${editing.id === me.id} onClose=${() => setEditing(null)} onSaved=${() => (setEditing(null), list.reload())} />`}
	`;
}

function Editor({ u, self, onClose, onSaved }) {
	const isNew = !u.id;
	const [username, setUsername] = useState(u.username || "");
	const [role, setRole] = useState(u.role || "operator");
	const [password, setPassword] = useState("");
	const [err, setErr] = useState("");
	const save = async () => {
		setErr("");
		if (isNew && !/^[\w.@-]{2,32}$/.test(username.trim())) return setErr("用户名为 2-32 位字母、数字或 _ . @ -");
		if (self && role !== u.role && !(await confirmDialog({ title: "修改自己的角色", text: "修改自己的角色后当前登录会失效，需要重新登录。继续？", okText: "继续" }))) return;
		try {
			if (isNew) await api("POST", "/users", { username: username.trim(), role, password });
			else await api("PUT", `/users/${u.id}`, { role, ...(password ? { password } : {}) });
			onSaved();
			run(async () => 0, isNew ? "用户已创建" : password ? "已保存，该用户需用新口令重新登录" : "已保存");
		} catch (e) {
			setErr(e.message);
		}
	};
	return html`<${Modal}
		title=${isNew ? "新建用户" : `编辑用户：${u.username}`}
		onClose=${onClose}
		footer=${html`${err && html`<span class="text-bad small grow">${err}</span>`}<button class="ghost" onClick=${onClose}>取消</button><${AsyncButton} class="primary" onClick=${save}>保存<//>`}
	>
		<${Field} label="用户名"><input value=${username} disabled=${!isNew} autocomplete="off" onInput=${(e) => setUsername(e.target.value)} autofocus=${isNew} /><//>
		<${Field} label="角色">
			<select value=${role} onChange=${(e) => setRole(e.target.value)}>
				<option value="admin">管理员（全部权限）</option><option value="operator">运维（程序、实例、机器、会话、访问链接）</option><option value="viewer">只读（仅查看）</option>
			</select>
		<//>
		<${Field} label=${isNew ? "口令" : "重置口令"} hint=${`至少 8 位，包含字母和数字${isNew ? "" : "；留空表示不修改"}`}>
			<input type="password" autocomplete="new-password" value=${password} onInput=${(e) => setPassword(e.target.value)} />
		<//>
	<//>`;
}
