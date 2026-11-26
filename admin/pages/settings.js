import { html, usePoll, api, run, Card, Field, Badge, Table, Modal, fmt, useState, useEffect, useRef, useStore, copyText, confirmDialog, ROLE_LABEL, AsyncButton, store, Icon, toast } from "../lib.js";
import { ConfigSection, BootstrapInfo } from "./sysconfig.js";

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

/** 设置分区：左侧分组菜单。cfg:* 为系统参数（配置中心）的分组 */
const SECTIONS = [
	{
		group: "常用",
		items: [
			{ key: "access", label: "访问与嵌入", icon: "globe" },
			{ key: "ice", label: "播放链路", icon: "activity" },
			{ key: "alerts", label: "告警通知", icon: "alert" },
		],
	},
	{
		group: "安全与接入",
		items: [
			{ key: "security", label: "观众与接口安全", icon: "shield" },
			{ key: "cfg:network", label: "网络与访问控制", icon: "lock" },
		],
	},
	{
		group: "运行参数",
		items: [
			{ key: "cfg:agent", label: "本机 Agent", icon: "server" },
			{ key: "cfg:log", label: "日志与数据保留", icon: "terminal" },
			{ key: "cfg:downloads", label: "Agent 安装包", icon: "download" },
			{ key: "cfg:turn", label: "内置 TURN", icon: "wifi", advanced: true, desc: "须与 nginx 配置、防火墙端口一致，一般保持部署时的设置" },
		],
	},
	{
		group: "集成与维护",
		items: [
			{ key: "tokens", label: "API 令牌", icon: "key" },
			{ key: "backup", label: "备份与恢复", icon: "upload" },
			{ key: "system", label: "系统信息", icon: "info" },
		],
	},
];
const ALL_SECTIONS = SECTIONS.flatMap((g) => g.items);
const LEGACY_TAB = { sysconfig: "cfg:network" }; // 旧链接 #/settings?tab=sysconfig
const SAVABLE = new Set(["access", "ice", "security", "alerts"]);
/** 搜索索引：运行期设置等固定条目（系统参数的条目来自 /config） */
const STATIC_INDEX = [
	["access", "对外访问地址", "播放地址 嵌入 publicBaseUrl 域名"],
	["ice", "强制只走 TURN 中继", "forceRelay 中继"],
	["ice", "凭据有效期", "ttl UE 凭据"],
	["ice", "单 IP 最多观众", "maxPlayersPerIp"],
	["ice", "TURN / STUN 服务器", "ICE coturn 共享密钥 @builtin"],
	["security", "观众 IP 白名单", "viewerAllow 白名单"],
	["security", "允许跨域调用 API 的来源", "CORS corsOrigins"],
	["security", "工具接口免登录", "寻路 坐标转换 publicTools"],
	["security", "限流", "每秒 突发 rateLimit"],
	["alerts", "告警 Webhook", "企业微信 钉钉 飞书 告警事件 排队"],
	["tokens", "API 令牌", "二次开发 Bearer"],
	["tokens", "单点登录", "SSO sso-link"],
	["backup", "备份与恢复", "导出 导入 restore"],
	["system", "启动参数", "端口 数据目录 TLS 证书 show-config 版本 日志目录"],
];
const initialSection = () => {
	const t = location.hash.split("?tab=")[1] || "access";
	const k = LEGACY_TAB[t] || t;
	return ALL_SECTIONS.some((x) => x.key === k) ? k : "access";
};

export function Settings() {
	const s = useStore();
	const cfg = usePoll(() => api("GET", "/settings"), []);
	const [tab, setTab] = useState(initialSection);
	const [conf, setConf] = useState(null);
	const [q, setQ] = useState("");
	const [flash, setFlash] = useState(null);
	const goRef = useRef(null);
	const [v, setV] = useState(null);
	const [txt, setTxt] = useState({ viewerAllow: "", corsOrigins: "" });
	const [base, setBase] = useState(null);
	const [sysDirty, setSysDirty] = useState(false);
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
	const loadConf = async () => {
		try {
			setConf(await api("GET", "/config"));
		} catch (e) {
			toast(`加载系统参数失败：${e.message}`, "bad");
		}
	};
	useEffect(() => {
		loadConf();
	}, []);
	// 其他管理员修改了系统参数（实时推送的版本号变化）：未编辑时自动刷新
	const remoteRev = s.overview?.config?.rev;
	const confStale = !!conf && remoteRev !== undefined && remoteRev !== conf.rev;
	useEffect(() => {
		if (confStale && !sysDirty) loadConf();
	}, [confStale, sysDirty]);
	useEffect(() => {
		const h = `#/settings?tab=${tab}`;
		if (location.hash !== h) history.replaceState(null, "", h);
	}, [tab]);
	// 已在本页时点击「#/settings?tab=…」链接（例如顶部的待重启提示）：切换到对应分区
	useEffect(() => {
		const f = () => {
			const k = initialSection();
			if (k !== tab) goRef.current ? goRef.current(k) : setTab(k);
		};
		window.addEventListener("hashchange", f);
		return () => window.removeEventListener("hashchange", f);
	});
	// 搜索结果跳转：滚动到该项并短暂高亮
	useEffect(() => {
		if (!flash) return;
		const t1 = setTimeout(() => document.querySelector(`[data-key="${flash}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
		const t2 = setTimeout(() => setFlash(null), 2200);
		return () => (clearTimeout(t1), clearTimeout(t2));
	}, [flash, tab, conf]);
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
	const go = async (k, key) => {
		if (k !== tab) {
			if (tab.startsWith("cfg:") && sysDirty && !(await confirmDialog({ title: "放弃未保存的修改", text: `「${ALL_SECTIONS.find((x) => x.key === tab).label}」有未保存的修改，切换后将丢弃。继续？`, okText: "丢弃并切换" }))) return;
			if (dirty && SAVABLE.has(tab) && !SAVABLE.has(k) && !(await confirmDialog({ title: "有未保存的修改", text: "当前设置有未保存的修改，切换后修改仍会保留，但需要回到原来的分区保存才会生效。继续？", okText: "继续", danger: false }))) return;
			setSysDirty(false);
			setTab(k);
		}
		setQ("");
		setFlash(key || null);
	};
	goRef.current = go;
	const cur = ALL_SECTIONS.find((x) => x.key === tab) || ALL_SECTIONS[0];
	const pendingIn = (key) => (key.startsWith("cfg:") && conf ? conf.items.filter((i) => i.group === key.slice(4) && i.pending).length : 0);
	const index = [...STATIC_INDEX.map(([section, label, kw]) => ({ section, label, text: `${label} ${kw}` })), ...(conf?.items || []).map((i) => ({ section: `cfg:${i.group}`, label: i.label, key: i.key, text: `${i.label} ${i.hint} ${i.help} ${i.key} ${i.env || ""}` }))];
	const needle = q.trim().toLowerCase();
	const results = needle ? index.filter((e) => e.text.toLowerCase().includes(needle)).slice(0, 30) : null;
	const navItem = (it) => {
		const p = pendingIn(it.key);
		const unsaved = it.key === tab && ((SAVABLE.has(it.key) && dirty) || (it.key.startsWith("cfg:") && sysDirty));
		return html`<button type="button" class=${"snav-i" + (tab === it.key ? " on" : "")} aria-current=${tab === it.key ? "page" : undefined} onClick=${() => go(it.key)}>
			<${Icon} name=${it.icon} size=${16} /><span class="grow">${it.label}</span>
			${it.advanced && html`<span class="set-tag">高级</span>`}
			${p ? html`<em class="pill warn" title="已保存、重启平台后生效的项">${p}</em>` : unsaved ? html`<i class="unsaved" title="有未保存的修改"></i>` : ""}
		</button>`;
	};
	return html`<div class="settings">
		<aside class="snav">
			<label class="snav-search"><${Icon} name="search" size=${15} /><input type="search" placeholder="搜索设置项…" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="搜索设置项" /></label>
			<select class="snav-select" value=${tab} aria-label="设置分区" onChange=${(e) => go(e.target.value)}>
				${SECTIONS.map((g) => html`<optgroup label=${g.group}>${g.items.map((it) => html`<option value=${it.key}>${it.label}${pendingIn(it.key) ? "（待重启）" : ""}</option>`)}</optgroup>`)}
			</select>
			${results
				? html`<div class="snav-results">
						${results.length
							? results.map((r) => html`<button type="button" class="snav-r" onClick=${() => go(r.section, r.key)}><span>${r.label}</span><small>${ALL_SECTIONS.find((x) => x.key === r.section)?.label}</small></button>`)
							: html`<div class="faint small snav-none">没有匹配的设置项</div>`}
					</div>`
				: SECTIONS.map((g) => html`<div class="snav-g">${g.group}</div>${g.items.map(navItem)}`)}
		</aside>
		<section class="settings-main">
			<header class="settings-head">
				<h2>${cur.label}${cur.advanced ? html` <span class="set-tag">高级</span>` : ""}</h2>
				${cur.desc && html`<p>${cur.desc}</p>`}
			</header>
		${tab === "access" &&
		html`<${Card}>
			<div class="narrow" style="max-width:640px">
				<${Field} label="对外访问地址" hint="观众访问 nginx 的地址，不带路径；留空 = 使用管理口地址（外网无法访问）" error=${v.publicBaseUrl && !/^https?:\/\/[^/\s?#]+\/?$/i.test(v.publicBaseUrl.trim()) ? "格式应为 http(s)://主机[:端口]" : ""}>
					<input value=${v.publicBaseUrl || ""} placeholder="https://ue.example.com:8443" onInput=${(e) => setV({ ...v, publicBaseUrl: e.target.value })} />
				<//>
				<p class="faint small">播放地址：<code>/play/程序ID</code> 或 <code>/video.html?urlPrefix=程序ID</code></p>
			</div>
		<//>`}
		${tab === "ice" &&
		html`<${Card}>
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
			<h4>TURN / STUN 服务器 <span class="set-help" tabindex="0" title="浏览器与 UE 自动择优：内网直连 → 数据中心 TURN → nginx 同端口 TURN。{host}/{port} 替换为观众访问的地址；密钥 @builtin = 内置 TURN。修改后对新连接生效，UE 专用配置需重启实例"><${Icon} name="info" size=${13} /></span></h4>
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
					${s.scope === "ue" && (s.urls || []).some((u) => !/127\.0\.0\.1|localhost|\{host\}/.test(u)) && html`<div class="alert warn">UE 必须能直接访问此地址（与 UE 同机时用 <code>turn:127.0.0.1:端口</code>）；内网 UE 通常不需要。</div>`}
					<${Field} label="地址（每行一个）">
						<textarea rows="3" placeholder=${"turn:{host}:{port}?transport=tcp\nstun:turn.example.com:3478"} value=${(s.urls || []).join("\n")} onInput=${(e) => setServer(i, { urls: e.target.value.split(/\s+/).filter(Boolean) })}></textarea>
					<//>
					<${Field} label="共享密钥" hint="****** = 不变；@builtin = 内置 TURN">
						<input value=${s.secret || ""} autocomplete="off" onInput=${(e) => setServer(i, { secret: e.target.value })} />
					<//>
				</div>`
			)}
			<button class="ghost" onClick=${() => setTurn({ servers: [...t.servers, { ...NEW_SERVER }] })}><${Icon} name="plus" />添加服务器</button>
		<//>`}
		${tab === "security" &&
		html`<${Card}>
			<div class="form-grid">
				<${Field} label="观众 IP 白名单">
					<input value=${txt.viewerAllow} placeholder="不限" onInput=${(e) => setTxt({ ...txt, viewerAllow: e.target.value })} />
				<//>
				<${Field} label="跨域来源（CORS）">
					<input value=${txt.corsOrigins} placeholder="不允许，例如 https://app.example.com" onInput=${(e) => setTxt({ ...txt, corsOrigins: e.target.value })} />
				<//>
				<label class="check"><input type="checkbox" checked=${!!sec.publicTools} onChange=${(e) => setSec({ publicTools: e.target.checked })} /> 寻路 / 坐标转换接口免登录</label>
			</div>
			<h4>每 IP 限流 <span class="faint small">0 = 不限</span></h4>
			<div class="row3 four">
				<${Field} label="观众连接每秒新建"><input type="number" min="0" value=${sec.rateLimit.wsPerSec} onInput=${(e) => setRl("wsPerSec", e.target.value)} /><//>
				<${Field} label="观众连接突发上限"><input type="number" min="0" value=${sec.rateLimit.wsBurst} onInput=${(e) => setRl("wsBurst", e.target.value)} /><//>
				<${Field} label="API 每秒请求"><input type="number" min="0" value=${sec.rateLimit.apiPerSec} onInput=${(e) => setRl("apiPerSec", e.target.value)} /><//>
				<${Field} label="API 突发上限"><input type="number" min="0" value=${sec.rateLimit.apiBurst} onInput=${(e) => setRl("apiBurst", e.target.value)} /><//>
			</div>
			<//>`}
		${tab === "alerts" &&
		html`<${Card} title="Webhook" extra=${html`<${AsyncButton} class="ghost" disabled=${dirty || !al.webhook} title=${dirty ? "请先保存" : ""} onClick=${() => run(() => api("POST", "/alerts/test"), "测试消息已发送，请在群里查看")}>发送测试消息<//>`}>
			<div class="form-grid">
				<${Field} label="地址" hint="留空 = 不发送"><input value=${al.webhook} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" onInput=${(e) => setAl({ webhook: e.target.value.trim() })} /><//>
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
			${tab.startsWith("cfg:") &&
			(conf
				? html`<${ConfigSection} data=${conf} group=${tab.slice(4)} onSaved=${setConf} onDirty=${setSysDirty} highlight=${flash} stale=${confStale} onReload=${loadConf} />`
				: html`<div class="boot"><span class="spin"></span> 加载中…</div>`)}
			${tab === "tokens" && html`<${ApiTokens} />`}
			${tab === "backup" && html`<${Backup} onRestored=${() => (cfg.reload(), loadConf())} />`}
			${tab === "system" && html`<${SystemInfo} />${conf && html`<h3 class="set-sub">启动参数（只读）</h3><${BootstrapInfo} data=${conf} />`}`}
			${SAVABLE.has(tab) &&
			dirty &&
			html`<div class="savebar">
				<span class="text-warn small">有未保存的修改</span>
				<button class="ghost" onClick=${() => load(cfg.data)}>撤销修改</button>
				<${AsyncButton} class="primary" disabled=${!dirty || badBase} title=${badBase ? "对外访问地址格式不正确" : ""} onClick=${save}>保存设置<//>
			</div>`}
		</section>
	</div>`;
}

function SystemInfo() {
	const sys = usePoll(() => api("GET", "/system"), [], 10000);
	const st = sys.data;
	return html`<${Card}>
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
	return html`<${Card} title="API 令牌（二次开发）" extra=${html`<button class="primary" onClick=${() => setCreating(true)}><${Icon} name="plus" />新建令牌</button>`}>
		<p class="faint small">请求头 <code>Authorization: Bearer 令牌</code> 调用 <code>/api/v1/*</code>，说明见 docs/API.md。</p>
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
		<p class="faint small">导出程序、机器、系统设置与系统参数（不含用户、口令与密钥）。</p>
		<div class="card-actions">
			<${AsyncButton} class="primary" onClick=${download}>导出配置<//>
			<label class="btn ghost">导入配置<input type="file" accept="application/json,.json" hidden onChange=${upload} /></label>
		</div>
	<//>`;
}
