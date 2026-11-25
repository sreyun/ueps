import { html, api, run, Card, Field, useState, useStore, store, ROLE_LABEL, Badge, copyText, confirmDialog, AsyncButton, disconnectEvents } from "../lib.js";

export function Account() {
	const s = useStore();
	return html`
		<${Password} s=${s} />
		<${Totp} s=${s} />
		<${Card} title="登录会话">
			<p class="muted small">在其它电脑上登录过、或怀疑口令泄露时，可让所有设备上的登录立即失效（包括当前页面）。</p>
			<${AsyncButton} class="danger" onClick=${async () => {
				if (!(await confirmDialog({ title: "退出所有设备", text: "所有设备上的登录（包括当前页面）将立即失效，需要重新登录。确定？", okText: "全部退出" }))) return;
				if (await run(() => api("POST", "/auth/logout-all"))) {
					disconnectEvents();
					store.set({ user: null, overview: null });
				}
			}}>退出所有设备<//>
		<//>
	`;
}

function Password({ s }) {
	const [oldPassword, setOld] = useState("");
	const [newPassword, setNew] = useState("");
	const [again, setAgain] = useState("");
	const [err, setErr] = useState("");
	const submit = async (e) => {
		e.preventDefault();
		setErr("");
		if (newPassword !== again) return setErr("两次输入的新口令不一致");
		try {
			await api("POST", "/auth/password", { oldPassword, newPassword });
			store.set({ mustChangePassword: false });
			setOld("");
			setNew("");
			setAgain("");
			run(async () => 0, "口令已修改，其它设备上的登录已失效");
		} catch (e2) {
			setErr(e2.message);
		}
	};
	return html`<${Card} title=${`账户：${s.user.username}（${ROLE_LABEL[s.user.role]}）`}>
		${s.mustChangePassword && html`<div class="alert warn">当前使用的是初始口令，请立即修改。修改后请删除数据目录中的 initial-admin.txt。</div>`}
		<form class="narrow" onSubmit=${submit}>
			<${Field} label="原口令"><input type="password" autocomplete="current-password" value=${oldPassword} onInput=${(e) => setOld(e.target.value)} required /><//>
			<${Field} label="新口令" hint="至少 8 位，包含字母和数字"><input type="password" autocomplete="new-password" value=${newPassword} onInput=${(e) => setNew(e.target.value)} required /><//>
			<${Field} label="再次输入新口令"><input type="password" autocomplete="new-password" value=${again} onInput=${(e) => setAgain(e.target.value)} required /><//>
			${err && html`<div class="alert bad">${err}</div>`}
			<button class="primary">修改口令</button>
		</form>
	<//>`;
}

function Totp({ s }) {
	const [setup, setSetup] = useState(null);
	const [code, setCode] = useState("");
	const [password, setPassword] = useState("");
	const enabled = !!s.user.totp;
	const start = async () => {
		const r = await run(() => api("POST", "/auth/totp/setup"));
		if (r?.secret) setSetup(r);
	};
	const enable = async () => {
		if (await run(() => api("POST", "/auth/totp/enable", { code }), "两步验证已开启，下次登录需要输入验证码")) {
			store.set({ user: { ...s.user, totp: true } });
			setSetup(null);
			setCode("");
		}
	};
	const disable = async () => {
		if (await run(() => api("POST", "/auth/totp/disable", { password }), "两步验证已关闭")) {
			store.set({ user: { ...s.user, totp: false } });
			setPassword("");
		}
	};
	return html`<${Card} title="两步验证" extra=${enabled ? html`<${Badge} tone="ok">已开启<//>` : html`<${Badge}>未开启<//>`}>
		<p class="muted small">开启后登录除口令外还需要手机验证器（Google Authenticator、Microsoft Authenticator、腾讯身份验证器等）生成的 6 位动态码。强烈建议管理员开启。</p>
		${enabled
			? html`<div class="narrow">
					<${Field} label="输入当前口令以关闭"><input type="password" value=${password} onInput=${(e) => setPassword(e.target.value)} /><//>
					<${AsyncButton} class="danger" disabled=${!password} onClick=${disable}>关闭两步验证<//>
				</div>`
			: !setup
			? html`<${AsyncButton} class="primary" onClick=${start}>开启两步验证<//>`
			: html`<div class="narrow">
					<ol class="steps">
						<li>在验证器 App 中选择"手动输入密钥"，账户填 <b>${s.user.username}</b>，密钥：<pre class="code">${setup.secret}</pre><button class="ghost sm" onClick=${() => copyText(setup.secret)}>复制密钥</button></li>
						<li>或在支持的设备上打开链接：<a href=${setup.otpauth}>添加到验证器</a></li>
						<li>输入 App 显示的 6 位验证码完成开启（10 分钟内有效）：</li>
					</ol>
					<${Field} label="验证码"><input inputmode="numeric" maxlength="6" value=${code} onInput=${(e) => setCode(e.target.value.replace(/\D/g, ""))} /><//>
					<${AsyncButton} class="primary" disabled=${code.length !== 6} onClick=${enable}>确认开启<//>
				</div>`}
	<//>`;
}
