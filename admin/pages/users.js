import { html, usePoll, api, run, Card, Table, Badge, Modal, Field, fmt, useState, confirmDialog, ROLE_LABEL, useStore } from "../lib.js";

export function Users() {
	const list = usePoll(() => api("GET", "/users"), []);
	const me = useStore().user;
	const [editing, setEditing] = useState(null);
	const del = (u) => confirmDialog(`确定删除用户 ${u.username}？`) && run(() => api("DELETE", `/users/${u.id}`), "已删除").then(list.reload);
	const forceLogout = (u) => confirmDialog(`确定让 ${u.username} 所有设备上的登录失效？`) && run(() => api("POST", `/users/${u.id}/logout`), "已强制下线");
	const resetTotp = (u) => confirmDialog(`确定重置 ${u.username} 的两步验证？其下次登录只需口令。`) && run(() => api("PUT", `/users/${u.id}`, { resetTotp: true }), "已重置").then(list.reload);
	const toggle = (u) => run(() => api("PUT", `/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? "已启用" : "已禁用").then(list.reload);
	return html`
		<${Card} title="用户" extra=${html`<button class="primary" onClick=${() => setEditing({})}>新建用户</button>`}>
			<p class="muted small">角色：管理员（全部权限）· 运维（程序、实例、机器、会话、访问链接）· 只读（查看）。</p>
			<${Table}
				rows=${list.data}
				columns=${[
					{ title: "用户名", render: (u) => html`<b>${u.username}</b>${u.id === me.id ? html` <${Badge} tone="info">当前<//>` : ""}` },
					{ title: "角色", render: (u) => ROLE_LABEL[u.role] },
					{ title: "状态", render: (u) => html`${u.disabled ? html`<${Badge} tone="bad">已禁用<//>` : html`<${Badge} tone="ok">正常<//>`} ${u.totp ? html`<${Badge} tone="info">两步验证<//>` : ""}` },
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
		${editing && html`<${Editor} u=${editing} onClose=${() => setEditing(null)} onSaved=${() => (setEditing(null), list.reload())} />`}
	`;
}

function Editor({ u, onClose, onSaved }) {
	const isNew = !u.id;
	const [username, setUsername] = useState(u.username || "");
	const [role, setRole] = useState(u.role || "operator");
	const [password, setPassword] = useState("");
	const [err, setErr] = useState("");
	const save = async () => {
		setErr("");
		try {
			if (isNew) await api("POST", "/users", { username, role, password });
			else await api("PUT", `/users/${u.id}`, { role, ...(password ? { password } : {}) });
			onSaved();
			run(async () => 0, "已保存");
		} catch (e) {
			setErr(e.message);
		}
	};
	return html`<${Modal}
		title=${isNew ? "新建用户" : `编辑用户：${u.username}`}
		onClose=${onClose}
		footer=${html`${err && html`<span class="text-bad small grow">${err}</span>`}<button class="ghost" onClick=${onClose}>取消</button><button class="primary" onClick=${save}>保存</button>`}
	>
		<${Field} label="用户名"><input value=${username} disabled=${!isNew} onInput=${(e) => setUsername(e.target.value)} /><//>
		<${Field} label="角色">
			<select value=${role} onChange=${(e) => setRole(e.target.value)}>
				<option value="admin">管理员</option><option value="operator">运维</option><option value="viewer">只读</option>
			</select>
		<//>
		<${Field} label=${isNew ? "口令" : "重置口令"} hint="至少 8 位，包含字母和数字${isNew ? "" : "；留空表示不修改"}">
			<input type="password" autocomplete="new-password" value=${password} onInput=${(e) => setPassword(e.target.value)} />
		<//>
	<//>`;
}
