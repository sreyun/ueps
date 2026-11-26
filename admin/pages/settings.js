import { html, usePoll, api, run, Card, Field, Badge, Table, Modal, fmt, useState, useEffect, copyText, confirmDialog, ROLE_LABEL, Tabs, AsyncButton, store } from "../lib.js";

const NEW_SERVER = { id: "", name: "", urls: [], secret: "", scope: "player", audience: "all", enable: true };
const ALERT_EVENTS = {
	"agent.offline": "渲染机离线",
	"agent.online": "渲染机上线",
	"agent.conflict": "渲染机名称冲突（被拒绝接入）",
	"instance.failed": "实例启动失败",
	"program.capacity": "资源不足（无可用机器/GPU）",
	"queue.backlog": "观众排队积压",
	"turn.down": "内置 TURN 异常退出",
	"security.login_locked": "登录失败被锁定",
};
const list = (s) => String(s || "").split(/[,，\s]+/).filter(Boolean);
const TABS = [
	["access", "访问与嵌入"],
	["ice", "播放链路"],
	["security", "安全"],
	["alerts", "告警通知"],
	["tokens", "API 令牌"],
	["backup", "备份与恢复"],
	["system", "系统信息"],
];
const SAVABLE = new Set(["access", "ice", "security", "alerts"]);

export function Settings() {
	const cfg = usePoll(() => api("GET", "/settings"), []);
	const [tab, setTab] = useState(() => (location.hash.split("?tab=")[1] || "access"));
	const [v, setV] = useState(null);
	const [txt, setTxt] = useState({ viewerAllow: "", corsOrigins: "" });
	const [base, setBase] = useState(null);
	const load = (d) => {
		const t = { viewerAllow: (d.security?.viewerAllow || []).join(", "), corsOrigins: (d.security?.corsOrigins || []).join(", ") };
		setV(structuredClone(d));
		setTxt(t);
		setBase(JSON.stringify({ v: d, t }));
	};
	useEffect(() => cfg.data && load(cfg.data), [cfg.data]);
	const dirty = v && base !== JSON.stringify({ v, t: txt });
	useEffect(() => {
		const warn = (e) => dirty && (e.preventDefault(), (e.returnValue = ""));
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	if (cfg.error && !v) return html`<div class="alert bad">加载设置失败：${cfg.error}</div>`;
	if (!v) return html`<div class="boot"><span class="spin"></span> 加载中…</div>`;
	const t = v.turn;
	const sec = v.security;
	const al = v.alerts;
	const badBase = !!(v.publicBaseUrl && !/^https?:\/\/[^/\s?#]+\/?$/i.test(String(v.publicBaseUrl).trim()));
	const setTurn = (patch) => setV({ ...v, turn: { ...t, ...patch } });
	const setSec = (patch) => setV({ ...v, security: { ...sec, ...patch } });
	const setRl = (k, val) => setSec({ rateLimit: { ...sec.rateLimit, [k]: Math.max(0, +val || 0) } });
	const setAl = (patch) => setV({ ...v, alerts: { ...al, ...patch } });
	const setServer = (i, patch) => setTurn({ servers: t.servers.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
	const save = async () => {
		const body = { ...v, publicBaseUrl: String(v.publicBaseUrl || "").trim().replace(/\/+$/, ""), security: { ...sec, viewerAllow: list(txt.viewerAllow), corsOrigins: list(txt.corsOrigins) } };
		const r = await run(() => api("PUT", "/settings", body), "已保存，立即生效");
		if (r && r !== true) {
			load(r);
			store.set({ publicBaseUrl: r.publicBaseUrl || "" });
		}
	};
	const switchTab = async (k) => {
		if (dirty && SAVABLE.has(tab) && !SAVABLE.has(k) && !(await confirmDialog({ title: "有未保存的修改", text: "当前设置有未保存的修改，切换后修改仍会保留，但需要回到前面的选项卡保存才会生效。继续？", okText: "继续", danger: false }))) return;
		setTab(k);
	};
	return html`
		<${Tabs} tabs=${TABS.map(([k, l]) => [k, l, dirty && SAVABLE.has(k) && k === tab ? "未保存" : ""])} value=${tab} onChange=${switchTab} />
		${tab === "access" &&
		html`<${Card} title="对外访问地址" sub="观众访问 nginx 的地址：生成播放地址、访问链接、嵌入代码时使用">
			<div class="narrow" style="max-width:640px">
				<${Field} label="对外访问地址" hint="http(s)://域名或IP[:端口]，不带路径。例如 https://ue.example.com:8443 或 http://203.0.113.10:61556。留空则使用管理口地址（外网无法访问）" error=${v.publicBaseUrl && !/^https?:\/\/[^/\s?#]+\/?$/i.test(v.publicBaseUrl.trim()) ? "格式应为 http(s)://主机[:端口]" : ""}>
					<input value=${v.publicBaseUrl || ""} placeholder="https://ue.example.com:8443" onInput=${(e) => setV({ ...v, publicBaseUrl: e.target.value })} />
				<//>
				<p class="muted small">播放地址格式与企业版兼容：<code>/video.html?urlPrefix=程序ID</code>；也可用 <code>/play/程序ID</code>。同一个对外端口同时支持 http:// 与 https://。业务系统是 https 页面时，请填写 https 地址并使用受信任证书。</p>
			</div>
		<//>`}
		${tab === "ice" &&
		html`<${Card} title="ICE / TURN（播放链路）">
			<p class="muted small">
				浏览器与 UE 自动在多条路径中择优：内网直连 → 数据中心 TURN（UDP）→ nginx 同端口 TURN（TCP/TLS）。地址中的 <code>{host}</code>/<code>{port}</code>
				会替换为观众访问 nginx 时使用的地址；密钥填 <code>@builtin</code> 表示使用内置 TURN 的密钥。修改后对新连接的观众生效，已运行的 UE 实例需重启后才会使用新的 UE 专用配置。
			</p>
			<div class="form-grid">
				<${Field} label="强制只走 TURN 中继">
					<select value=${String(t.forceRelay)} onChange=${(e) => setTurn({ forceRelay: e.target.value === "true" ? true : e.target.value === "false" ? false : "external" })}>
						<option value="false">否（推荐，自动择优）</option>
						<option value="external">仅外网观众</option>
						<option value="true">所有观众</option>
					</select>
				<//>
				<div class="row3">
					<${Field} label="观众凭据有效期(秒)"><input type="number" min="60" value=${t.ttl} onInput=${(e) => setTurn({ ttl: +e.target.value })} /><//>
					<${Field} label="UE 凭据有效期(秒)"><input type="number" min="60" value=${t.ueTtl} onInput=${(e) => setTurn({ ueTtl: +e.target.value })} /><//>
					<${Field} label="单 IP 最多观众" hint="0 = 不限"><input type="number" min="0" value=${v.maxPlayersPerIp} onInput=${(e) => setV({ ...v, maxPlayersPerIp: Math.max(0, Math.floor(+e.target.value) || 0) })} /><//>
				</div>
			</div>
			<h4>TURN / STUN 服务器</h4>
			${t.servers.map(
				(s, i) => html`<div class="server" key=${i}>
					<div class="server-h">
						<input class="sm" placeholder="名称" value=${s.name || s.id || ""} onInput=${(e) => setServer(i, { name: e.target.value, id: s.id || e.target.value.replace(/\W+/g, "-").toLowerCase() })} />
						<label class="check small"><input type="checkbox" checked=${s.enable !== false} onChange=${(e) => setServer(i, { enable: e.target.checked })} />启用</label>
						<select class="sm" value=${s.scope || "player"} onChange=${(e) => setServer(i, { scope: e.target.value })}>
							<option value="player">只发给观众</option><option value="ue">只发给 UE</option><option value="all">观众和 UE</option>
						</select>
						<select class="sm" value=${s.audience || "all"} onChange=${(e) => setServer(i, { audience: e.target.value })}>
							<option value="all">所有观众</option><option value="external">仅外网观众</option><option value="lan">仅内网观众</option>
						</select>
						<span class="grow"></span>
						<button class="danger sm" onClick=${async () => (await confirmDialog({ title: "删除服务器", text: `删除「${s.name || s.id || "未命名"}」？保存后生效。`, okText: "删除" })) && setTurn({ servers: t.servers.filter((_, j) => j !== i) })}>删除</button>
					</div>
					${s.scope === "ue" && (s.urls || []).some((u) => !/127\.0\.0\.1|localhost|\{host\}/.test(u)) && html`<div class="alert warn">UE 专用 TURN 的地址必须是 UE 能直接访问到的 TURN 监听地址。内置 TURN 只监听 127.0.0.1，与 UE 同机时应为 <code>turn:127.0.0.1:端口</code>；内网真实 UE 通常不需要这一项。</div>`}
					<${Field} label="地址（每行一个）" hint="例：turn:{host}:{port}?transport=tcp、turns:turn.dc.com:443?transport=tcp、stun:turn.dc.com:3478">
						<textarea rows="3" value=${(s.urls || []).join("\n")} onInput=${(e) => setServer(i, { urls: e.target.value.split(/\s+/).filter(Boolean) })}></textarea>
					<//>
					<${Field} label="共享密钥（TURN REST API / coturn static-auth-secret）" hint="****** = 保持不变；@builtin = 内置 TURN">
						<input value=${s.secret || ""} autocomplete="off" onInput=${(e) => setServer(i, { secret: e.target.value })} />
					<//>
				</div>`
			)}
			<button class="ghost" onClick=${() => setTurn({ servers: [...t.servers, { ...NEW_SERVER }] })}>＋ 添加服务器</button>
		<//>`}
		${tab === "security" &&
		html`<${Card} title="安全">
			<div class="form-grid">
				<${Field} label="观众 IP 白名单（所有程序）" hint="逗号分隔的 IP/网段，空 = 不限；程序上还可单独设置">
					<input value=${txt.viewerAllow} placeholder="不限" onInput=${(e) => setTxt({ ...txt, viewerAllow: e.target.value })} />
				<//>
				<${Field} label="允许跨域调用 API 的来源（CORS）" hint="配合 API 令牌做二次开发，例如 https://app.example.com；空 = 不允许跨域">
					<input value=${txt.corsOrigins} placeholder="不允许" onInput=${(e) => setTxt({ ...txt, corsOrigins: e.target.value })} />
				<//>
				<label class="check"><input type="checkbox" checked=${!!sec.publicTools} onChange=${(e) => setSec({ publicTools: e.target.checked })} /> 寻路 / 坐标转换工具接口免登录开放（观众口也可调用）</label>
			</div>
			<h4>限流（每个来源 IP）</h4>
			<div class="row3 four">
				<${Field} label="观众连接每秒新建"><input type="number" min="0" value=${sec.rateLimit.wsPerSec} onInput=${(e) => setRl("wsPerSec", e.target.value)} /><//>
				<${Field} label="观众连接突发上限"><input type="number" min="0" value=${sec.rateLimit.wsBurst} onInput=${(e) => setRl("wsBurst", e.target.value)} /><//>
				<${Field} label="API 每秒请求"><input type="number" min="0" value=${sec.rateLimit.apiPerSec} onInput=${(e) => setRl("apiPerSec", e.target.value)} /><//>
				<${Field} label="API 突发上限"><input type="number" min="0" value=${sec.rateLimit.apiBurst} onInput=${(e) => setRl("apiBurst", e.target.value)} /><//>
			</div>
			<p class="muted small">0 = 不限。企业 NAT 下几十人共用一个出口 IP，观众连接限流不宜过严。前面还有一层反向代理时，请在部署配置中把它加入可信代理（UPSTREAM_PROXIES），否则所有观众会被当成同一个 IP。</p>
		<//>`}
		${tab === "alerts" &&
		html`<${Card} title="告警通知" extra=${html`<${AsyncButton} class="ghost" disabled=${dirty || !al.webhook} title=${dirty ? "请先保存" : ""} onClick=${() => run(() => api("POST", "/alerts/test"), "测试消息已发送，请在群里查看")}>发送测试消息<//>`}>
			<div class="form-grid">
				<${Field} label="Webhook 地址" hint="企业微信 / 钉钉 / 飞书群机器人地址，或任意接收 JSON 的地址；留空 = 不发送"><input value=${al.webhook} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" onInput=${(e) => setAl({ webhook: e.target.value.trim() })} /><//>
				<div class="row3">
					<${Field} label="格式">
						<select value=${al.format} onChange=${(e) => setAl({ format: e.target.value })}>
							<option value="generic">通用 JSON</option><option value="wecom">企业微信</option><option value="dingtalk">钉钉</option><option value="feishu">飞书</option>
						</select>
					<//>
					<${Field} label="排队告警阈值(秒)"><input type="number" min="0" value=${al.queueBacklogSec} onInput=${(e) => setAl({ queueBacklogSec: Math.max(0, +e.target.value || 0) })} /><//>
					<${Field} label="同类告警间隔(秒)"><input type="number" min="0" value=${al.throttleSec} onInput=${(e) => setAl({ throttleSec: Math.max(0, +e.target.value || 0) })} /><//>
				</div>
			</div>
			<h4>告警事件</h4>
			<div class="chips">
				${Object.entries(ALERT_EVENTS).map(
					([k, label]) => html`<label class="chip ${al.events.includes(k) ? "on" : ""}"><input type="checkbox" checked=${al.events.includes(k)} onChange=${(e) => setAl({ events: e.target.checked ? [...al.events, k] : al.events.filter((x) => x !== k) })} />${label}</label>`
				)}
			</div>
		<//>`}
		${tab === "tokens" && html`<${ApiTokens} />`}
		${tab === "backup" && html`<${Backup} onRestored=${cfg.reload} />`}
		${tab === "system" && html`<${SystemInfo} />`}
		${SAVABLE.has(tab) &&
		html`<div class="savebar">
			<span class=${dirty ? "text-warn small" : "muted small"}>${dirty ? "有未保存的修改" : "所有修改已保存"}</span>
			${dirty && html`<button class="ghost" onClick=${() => load(cfg.data)}>撤销修改</button>`}
			<${AsyncButton} class="primary" disabled=${!dirty || badBase} title=${badBase ? "对外访问地址格式不正确" : ""} onClick=${save}>保存设置<//>
		</div>`}
	`;
}

function SystemInfo() {
	const sys = usePoll(() => api("GET", "/system"), [], 10000);
	const st = sys.data;
	return html`<${Card} title="系统信息">
		${!st
			? html`<div class="boot"><span class="spin"></span></div>`
			: html`<div class="kv">
					<span>版本</span><span>${st.version}（Node ${st.node}，${st.platform}）</span>
					<span>运行时长</span><span>${fmt.dur(st.uptime * 1000)}</span>
					<span>内存 / 事件循环</span><span>${st.memoryMB} MB · 延迟 P99 ${st.loopDelayMs} ms</span>
					<span>端口</span><span>管理 ${st.ports.admin} · 观众 ${st.ports.public || "未启用"} · TLS ${st.ports.tls === "none" ? "未启用（由 nginx 提供）" : st.ports.tls === "both" ? "两个端口" : "观众口"}</span>
					<span>UE 连接地址</span><span><code>${st.ueHost}</code></span>
					<span>内置 TURN</span><span>${st.turn.enabled ? (st.turn.running ? html`<${Badge} tone="ok">运行中<//> ${st.turn.stats ? `${st.turn.stats.workers} 进程 · ${st.turn.stats.allocations} 分配 · 中继 ${st.turn.stats.relayIp}` : ""}` : html`<${Badge} tone="bad">未运行<//>`) : "未启用"}</span>
					<span>数据目录</span><span><code>${st.dataDir}</code></span>
					<span>网页托管</span><span><code>${st.siteDir}</code></span>
					<span>日志目录</span><span><code>${st.logDir || "未写文件"}</code></span>
				</div>`}
	<//>`;
}

function ApiTokens() {
	const tokens = usePoll(() => api("GET", "/api-tokens"), []);
	const [creating, setCreating] = useState(false);
	const [shown, setShown] = useState(null);
	const revoke = async (t) => {
		if (!(await confirmDialog({ title: "吊销令牌", text: `确定吊销令牌「${t.name}」？使用它的系统将立即无法访问。`, okText: "吊销" }))) return;
		if (await run(() => api("DELETE", `/api-tokens/${t.id}`), "已吊销")) tokens.reload();
	};
	return html`<${Card} title="API 令牌（二次开发）" extra=${html`<button class="primary" onClick=${() => setCreating(true)}>＋ 新建令牌</button>`}>
		<p class="muted small">业务系统用请求头 <code>Authorization: Bearer 令牌</code> 调用 <code>/api/v1/*</code>（需在管理网段内，或配置 CORS 来源），接口说明见 docs/API.md。令牌不能修改用户、口令和系统设置。</p>
		<${Table}
			rows=${tokens.data}
			loading=${tokens.loading}
			empty="还没有令牌"
			columns=${[
				{ title: "名称", render: (t) => html`<b>${t.name}</b>` },
				{ title: "角色", render: (t) => ROLE_LABEL[t.role] },
				{ title: "状态", render: (t) => (t.revoked ? html`<${Badge} tone="bad">已吊销<//>` : t.expires_at && t.expires_at < Date.now() ? html`<${Badge}>已过期<//>` : html`<${Badge} tone="ok">有效<//>`) },
				{ title: "到期", render: (t) => (t.expires_at ? fmt.time(t.expires_at) : "不限") },
				{ title: "最近使用", render: (t) => fmt.time(t.last_used_at) },
				{ title: "创建", render: (t) => html`${fmt.time(t.created_at)}<div class="muted small">${t.created_by}</div>` },
				{ title: "", class: "actions", render: (t) => !t.revoked && html`<button class="danger sm" onClick=${() => revoke(t)}>吊销</button>` },
			]}
		/>
		<details class="small sso-help">
			<summary>单点登录：业务系统中的用户免登录进入管理端</summary>
			<p class="muted">业务系统后台用<b>管理员</b>角色的令牌为指定用户生成一次性登录链接（默认 60 秒内有效、只能用一次），再让用户的浏览器打开该链接即可直接进入管理端（不再输入口令与两步验证，由业务系统负责认证）。用户须事先在「用户」中创建，权限按其角色。</p>
			<pre class="code">${`curl -X POST -H "Authorization: Bearer <管理员令牌>" -H "Content-Type: application/json" \\\n  ${location.origin}/api/v1/auth/sso-link -d '{"username":"zhangsan","redirect":"/programs"}'\n# 返回 {"url":"${location.origin}/api/v1/auth/sso?t=…","expiresAt":…}`}</pre>
			<p class="muted">可选参数：<code>ttl</code>（有效秒数，10-600）、<code>redirect</code>（进入后打开的页面，如 <code>/programs</code>、<code>/sessions</code>）、<code>base</code>（浏览器访问管理端的地址，默认取调用接口时的地址）。</p>
		</details>
		${creating &&
		html`<${TokenModal}
			onClose=${() => setCreating(false)}
			onCreated=${(t) => {
				setCreating(false);
				setShown(t);
				tokens.reload();
			}}
		/>`}
		${shown &&
		html`<${Modal} title="令牌已创建" onClose=${() => setShown(null)} footer=${html`<button class="primary" onClick=${() => setShown(null)}>我已保存</button>`}>
			<div class="alert warn">令牌只显示这一次，请立即复制保存。丢失后只能吊销并重新创建。</div>
			<pre class="code">${shown.token}</pre>
			<button class="primary" onClick=${() => copyText(shown.token)}>复制令牌</button>
		<//>`}
	<//>`;
}

function TokenModal({ onClose, onCreated }) {
	const [name, setName] = useState("");
	const [role, setRole] = useState("viewer");
	const [days, setDays] = useState(365);
	const submit = async () => {
		const t = await run(() => api("POST", "/api-tokens", { name: name.trim(), role, days: Math.max(0, +days || 0) }));
		if (t?.token) onCreated(t);
	};
	return html`<${Modal} title="新建 API 令牌" onClose=${onClose} footer=${html`<button class="ghost" onClick=${onClose}>取消</button><${AsyncButton} class="primary" onClick=${submit} disabled=${!name.trim()}>创建<//>`}>
		<${Field} label="名称（用途）"><input value=${name} maxlength="64" onInput=${(e) => setName(e.target.value)} placeholder="例如 大屏系统" autofocus /><//>
		<${Field} label="角色" hint="只读：查询；运维：可启停实例、改程序、生成访问链接；管理员：全部（不含账户安全接口）">
			<select value=${role} onChange=${(e) => setRole(e.target.value)}><option value="viewer">只读</option><option value="operator">运维</option><option value="admin">管理员</option></select>
		<//>
		<${Field} label="有效期（天）" hint="0 = 永不过期（不推荐）"><input type="number" min="0" value=${days} onInput=${(e) => setDays(e.target.value)} /><//>
	<//>`;
}

function Backup({ onRestored }) {
	const download = async () => {
		const data = await run(() => api("GET", "/backup"));
		if (!data || data === true) return;
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
		a.download = `ps-platform-backup-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	};
	const upload = async (e) => {
		const file = e.target.files[0];
		e.target.value = "";
		if (!file) return;
		let data;
		try {
			data = JSON.parse(await file.text());
		} catch {
			return run(() => Promise.reject(new Error("文件不是合法的 JSON")));
		}
		if (data?.kind !== "ps-platform-backup") return run(() => Promise.reject(new Error("不是本平台导出的备份文件")));
		if (!(await confirmDialog({ title: "导入配置", text: `将导入 ${data.programs?.length || 0} 个程序、${data.machines?.length || 0} 台机器的设置${data.settings ? "以及系统设置" : ""}，同名项会被覆盖（任一项不合法则整体不导入）。继续？`, okText: "导入", danger: false }))) return;
		const r = await run(() => api("POST", "/restore", data));
		if (r && r !== true) {
			run(async () => 0, `已恢复：程序 ${r.programs} 个，机器 ${r.machines} 台${r.settings ? "，系统设置已更新" : ""}`);
			onRestored();
		}
	};
	return html`<${Card} title="备份与恢复">
		<p class="muted small">导出程序、机器与系统设置（不含用户、口令、密钥）。迁移或重装后导入即可恢复配置。也可直接备份数据目录。</p>
		<div class="card-actions">
			<${AsyncButton} class="primary" onClick=${download}>导出配置<//>
			<label class="btn ghost">导入配置<input type="file" accept="application/json,.json" hidden onChange=${upload} /></label>
		</div>
	<//>`;
}
