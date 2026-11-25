import { html, usePoll, api, run, Card, Field, Badge, Table, Modal, fmt, useState, useEffect, copyText, confirmDialog, ROLE_LABEL } from "../lib.js";

const NEW_SERVER = { id: "", name: "", urls: [], secret: "", scope: "player", audience: "all", enable: true };
const ALERT_EVENTS = {
	"agent.offline": "渲染机离线",
	"agent.online": "渲染机上线",
	"instance.failed": "实例启动失败",
	"program.capacity": "资源不足（无可用机器/GPU）",
	"queue.backlog": "观众排队积压",
	"turn.down": "内置 TURN 异常退出",
	"security.login_locked": "登录失败被锁定",
};
const list = (s) => String(s || "").split(/[,，\s]+/).filter(Boolean);

export function Settings() {
	const cfg = usePoll(() => api("GET", "/settings"), []);
	const sys = usePoll(() => api("GET", "/system"), [], 10000);
	const [v, setV] = useState(null);
	const [txt, setTxt] = useState({ viewerAllow: "", corsOrigins: "" });
	useEffect(() => {
		if (!cfg.data) return;
		setV(structuredClone(cfg.data));
		setTxt({ viewerAllow: (cfg.data.security?.viewerAllow || []).join(", "), corsOrigins: (cfg.data.security?.corsOrigins || []).join(", ") });
	}, [cfg.data]);
	if (!v) return html`<div class="boot">加载中…</div>`;
	const t = v.turn;
	const sec = v.security;
	const al = v.alerts;
	const setTurn = (patch) => setV({ ...v, turn: { ...t, ...patch } });
	const setSec = (patch) => setV({ ...v, security: { ...sec, ...patch } });
	const setRl = (k, val) => setSec({ rateLimit: { ...sec.rateLimit, [k]: +val || 0 } });
	const setAl = (patch) => setV({ ...v, alerts: { ...al, ...patch } });
	const setServer = (i, patch) => setTurn({ servers: t.servers.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
	const save = () => run(() => api("PUT", "/settings", { ...v, security: { ...sec, viewerAllow: list(txt.viewerAllow), corsOrigins: list(txt.corsOrigins) } }), "已保存，立即生效").then(cfg.reload);
	const saveBtn = html`<button class="primary" onClick=${save}>保存全部设置</button>`;
	const st = sys.data;
	return html`
		<${Card} title="ICE / TURN（播放链路）" extra=${saveBtn}>
			<p class="muted small">
				浏览器与 UE 自动在多条路径中择优：内网直连 → 数据中心 TURN（UDP）→ nginx 同端口 TURN（TCP/TLS）。地址中的 <code>{host}</code>/<code>{port}</code>
				会替换为观众访问 nginx 时使用的地址（内网 IP、映射后的外网端口、域名都适用）；密钥填 <code>@builtin</code> 表示使用内置 TURN 的密钥。
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
					<${Field} label="观众凭据有效期(秒)"><input type="number" value=${t.ttl} onInput=${(e) => setTurn({ ttl: +e.target.value })} /><//>
					<${Field} label="UE 凭据有效期(秒)"><input type="number" value=${t.ueTtl} onInput=${(e) => setTurn({ ueTtl: +e.target.value })} /><//>
					<${Field} label="单 IP 最多观众" hint="0 = 不限"><input type="number" value=${v.maxPlayersPerIp} onInput=${(e) => setV({ ...v, maxPlayersPerIp: +e.target.value })} /><//>
				</div>
			</div>
			<h4>TURN / STUN 服务器</h4>
			${t.servers.map(
				(s, i) => html`<div class="server" key=${i}>
					<div class="server-h">
						<input class="sm" placeholder="名称" value=${s.name || s.id || ""} onInput=${(e) => setServer(i, { name: e.target.value, id: s.id || e.target.value.replace(/\W+/g, "-").toLowerCase() })} />
						<label class="check"><input type="checkbox" checked=${s.enable !== false} onChange=${(e) => setServer(i, { enable: e.target.checked })} />启用</label>
						<select class="sm" value=${s.scope || "player"} onChange=${(e) => setServer(i, { scope: e.target.value })}>
							<option value="player">只发给观众</option><option value="ue">只发给 UE</option><option value="all">观众和 UE</option>
						</select>
						<select class="sm" value=${s.audience || "all"} onChange=${(e) => setServer(i, { audience: e.target.value })}>
							<option value="all">所有观众</option><option value="external">仅外网观众</option><option value="lan">仅内网观众</option>
						</select>
						<button class="danger sm" onClick=${() => setTurn({ servers: t.servers.filter((_, j) => j !== i) })}>删除</button>
					</div>
					<${Field} label="地址（每行一个）" hint="例：turn:{host}:{port}?transport=tcp、turns:turn.dc.com:443?transport=tcp、stun:turn.dc.com:3478">
						<textarea rows="3" value=${(s.urls || []).join("\n")} onInput=${(e) => setServer(i, { urls: e.target.value.split(/\s+/).filter(Boolean) })}></textarea>
					<//>
					<${Field} label="共享密钥（TURN REST API / coturn static-auth-secret）" hint="****** = 保持不变；@builtin = 内置 TURN">
						<input value=${s.secret || ""} onInput=${(e) => setServer(i, { secret: e.target.value })} />
					<//>
				</div>`
			)}
			<button class="ghost" onClick=${() => setTurn({ servers: [...t.servers, { ...NEW_SERVER }] })}>+ 添加服务器</button>
		<//>

		<${Card} title="安全" extra=${saveBtn}>
			<div class="form-grid">
				<${Field} label="观众 IP 白名单（所有程序）" hint="逗号分隔的 IP/网段，空 = 不限；程序上还可单独设置">
					<input value=${txt.viewerAllow} placeholder="不限" onInput=${(e) => setTxt({ ...txt, viewerAllow: e.target.value })} />
				<//>
				<${Field} label="允许跨域调用 API 的来源（CORS）" hint="配合 API 令牌做二次开发，例如 https://app.example.com；空 = 不允许跨域">
					<input value=${txt.corsOrigins} placeholder="不允许" onInput=${(e) => setTxt({ ...txt, corsOrigins: e.target.value })} />
				<//>
				<label class="check"><input type="checkbox" checked=${!!sec.publicTools} onChange=${(e) => setSec({ publicTools: e.target.checked })} /> 寻路 / 坐标转换工具接口免登录开放（观众口也可调用）</label>
			</div>
			<h4>限流（每个 IP）</h4>
			<div class="row3 four">
				<${Field} label="WebSocket 每秒新建"><input type="number" value=${sec.rateLimit.wsPerSec} onInput=${(e) => setRl("wsPerSec", e.target.value)} /><//>
				<${Field} label="WebSocket 突发上限"><input type="number" value=${sec.rateLimit.wsBurst} onInput=${(e) => setRl("wsBurst", e.target.value)} /><//>
				<${Field} label="API 每秒请求"><input type="number" value=${sec.rateLimit.apiPerSec} onInput=${(e) => setRl("apiPerSec", e.target.value)} /><//>
				<${Field} label="API 突发上限"><input type="number" value=${sec.rateLimit.apiBurst} onInput=${(e) => setRl("apiBurst", e.target.value)} /><//>
			</div>
			<p class="muted small">0 = 不限。nginx 反代时请确保传递了真实 IP（X-Forwarded-For），否则所有观众会被当成同一个 IP。</p>
		<//>

		<${Card} title="告警通知" extra=${html`<button class="ghost" onClick=${() => run(() => api("POST", "/alerts/test"), "测试消息已发送")}>发送测试消息</button>${saveBtn}`}>
			<div class="form-grid">
				<${Field} label="Webhook 地址" hint="企业微信 / 钉钉 / 飞书群机器人地址，或任意接收 JSON 的地址"><input value=${al.webhook} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" onInput=${(e) => setAl({ webhook: e.target.value.trim() })} /><//>
				<div class="row3">
					<${Field} label="格式">
						<select value=${al.format} onChange=${(e) => setAl({ format: e.target.value })}>
							<option value="generic">通用 JSON</option><option value="wecom">企业微信</option><option value="dingtalk">钉钉</option><option value="feishu">飞书</option>
						</select>
					<//>
					<${Field} label="排队告警阈值(秒)"><input type="number" value=${al.queueBacklogSec} onInput=${(e) => setAl({ queueBacklogSec: +e.target.value })} /><//>
					<${Field} label="同类告警间隔(秒)"><input type="number" value=${al.throttleSec} onInput=${(e) => setAl({ throttleSec: +e.target.value })} /><//>
				</div>
			</div>
			<div class="chips">
				${Object.entries(ALERT_EVENTS).map(
					([k, label]) => html`<label class="chip ${al.events.includes(k) ? "on" : ""}"><input type="checkbox" checked=${al.events.includes(k)} onChange=${(e) => setAl({ events: e.target.checked ? [...al.events, k] : al.events.filter((x) => x !== k) })} />${label}</label>`
				)}
			</div>
		<//>

		<${ApiTokens} />
		<${Backup} onRestored=${cfg.reload} />

		<${Card} title="系统信息">
			${st &&
			html`<div class="kv">
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
		<//>
	`;
}

function ApiTokens() {
	const tokens = usePoll(() => api("GET", "/api-tokens"), []);
	const [creating, setCreating] = useState(false);
	const [shown, setShown] = useState(null);
	const revoke = (t) => confirmDialog(`确定吊销令牌「${t.name}」？使用它的系统将立即无法访问。`) && run(() => api("DELETE", `/api-tokens/${t.id}`), "已吊销").then(tokens.reload);
	return html`<${Card} title="API 令牌（二次开发）" extra=${html`<button class="primary" onClick=${() => setCreating(true)}>新建令牌</button>`}>
		<p class="muted small">业务系统用请求头 <code>Authorization: Bearer 令牌</code> 调用 <code>/api/v1/*</code>（需在管理网段内，或配置 CORS 来源）。令牌不能修改用户、口令和系统设置。</p>
		<${Table}
			rows=${tokens.data}
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
			<div class="alert warn">令牌只显示这一次，请立即复制保存。</div>
			<pre class="code wrap">${shown.token}</pre>
			<button class="primary" onClick=${() => copyText(shown.token)}>复制</button>
		<//>`}
	<//>`;
}

function TokenModal({ onClose, onCreated }) {
	const [name, setName] = useState("");
	const [role, setRole] = useState("viewer");
	const [days, setDays] = useState(365);
	const submit = async () => {
		const t = await run(() => api("POST", "/api-tokens", { name, role, days: +days || 0 }));
		if (t) onCreated(t);
	};
	return html`<${Modal} title="新建 API 令牌" onClose=${onClose} footer=${html`<button class="ghost" onClick=${onClose}>取消</button><button class="primary" onClick=${submit} disabled=${!name.trim()}>创建</button>`}>
		<${Field} label="名称（用途）"><input value=${name} onInput=${(e) => setName(e.target.value)} placeholder="例如 大屏系统" /><//>
		<${Field} label="角色" hint="只读：查询；运维：可启停实例、改程序、生成访问链接">
			<select value=${role} onChange=${(e) => setRole(e.target.value)}><option value="viewer">只读</option><option value="operator">运维</option><option value="admin">管理员</option></select>
		<//>
		<${Field} label="有效期（天）" hint="0 = 永不过期（不推荐）"><input type="number" min="0" value=${days} onInput=${(e) => setDays(e.target.value)} /><//>
	<//>`;
}

function Backup({ onRestored }) {
	const download = async () => {
		const data = await run(() => api("GET", "/backup"));
		if (!data) return;
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
		a.download = `ps-platform-backup-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
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
		if (!confirmDialog(`将导入 ${data.programs?.length || 0} 个程序、${data.machines?.length || 0} 台机器的设置${data.settings ? "以及系统设置" : ""}，同名项会被覆盖。继续？`)) return;
		const r = await run(() => api("POST", "/restore", data));
		if (r) {
			run(async () => 0, `已恢复：程序 ${r.programs} 个，机器 ${r.machines} 台${r.settings ? "，系统设置已更新" : ""}`);
			onRestored();
		}
	};
	return html`<${Card} title="备份与恢复">
		<p class="muted small">导出程序、机器与系统设置（不含用户、口令、密钥）。迁移或重装后导入即可恢复配置。</p>
		<div class="card-actions">
			<button class="primary" onClick=${download}>导出配置</button>
			<label class="btn ghost">导入配置<input type="file" accept="application/json" hidden onChange=${upload} /></label>
		</div>
	<//>`;
}
