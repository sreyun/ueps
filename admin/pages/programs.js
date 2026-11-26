import { html, usePoll, api, run, Card, Table, Badge, Modal, Field, useForm, can, useState, confirmDialog, useStore, Tabs, CopyLine, AsyncButton, Empty, publicUrl, hasPublicBase, playPath, legacyPath, embedCode, copyText } from "../lib.js";

const EMPTY = {
	id: "",
	name: "",
	description: "",
	exe: "",
	args: "",
	cwd: "",
	ue_version: "auto",
	mode: "exclusive",
	max_viewers: 1,
	prewarm: 0,
	max_instances: 4,
	idle_release_sec: 120,
	startup_timeout_sec: 120,
	res_x: 1920,
	res_y: 1080,
	fps: 30,
	gpu_mem_mb: 0,
	machines: [],
	require_token: false,
	public: true,
	enabled: true,
	exe_overrides: {},
	audio: true,
	max_bitrate_mbps: 0,
	min_bitrate_mbps: 0,
	inactive_release_sec: 0,
	one_session_per_ip: false,
	allow_ips: [],
	hide_cursor: false,
	allow_commands: false,
	prewarm_hours: "",
	fresh_instance: false,
	vip_preempt: true,
};

export function Programs() {
	const list = usePoll(() => api("GET", "/programs"), [], 5000);
	const s = useStore();
	const [editing, setEditing] = useState(null);
	const [access, setAccess] = useState(null);
	const del = async (p) => {
		if (!(await confirmDialog({ title: "删除程序", text: `确定删除程序「${p.name}」？\n其运行中的实例会被停止、排队观众会被断开，此操作不可撤销。`, okText: "删除" }))) return;
		if (await run(() => api("DELETE", `/programs/${p.id}`), "已删除")) list.reload();
	};
	const toggle = async (p) => {
		if (p.enabled && !(await confirmDialog({ title: "停用程序", text: `停用「${p.name}」后，正在观看的观众不受影响，但新观众无法进入、排队观众会被断开。确定停用？`, okText: "停用" }))) return;
		if (await run(() => api("PUT", `/programs/${p.id}`, { enabled: !p.enabled }), p.enabled ? "已停用" : "已启用")) list.reload();
	};
	const rows = list.data;
	return html`
		<${Card}
			title=${`程序${rows ? `（${rows.length}）` : ""}`}
			sub="一个程序 = 一个 UE 打包应用。观众进入时平台在空闲 GPU 上按需启动实例，观众离开后自动回收。"
			extra=${can("operator") && html`<button class="primary" onClick=${() => setEditing({ ...EMPTY })}>＋ 新建程序</button>`}
		>
			${!hasPublicBase() && html`<div class="alert info">尚未设置「对外访问地址」，复制的播放地址将使用当前管理口地址（外网观众无法访问）。${can("admin") ? html` <a href="#/settings">去设置</a>` : "请联系管理员设置。"}</div>`}
			<${Table}
				rows=${rows}
				loading=${list.loading}
				empty=${html`<${Empty} action=${can("operator") && html`<button class="primary" onClick=${() => setEditing({ ...EMPTY })}>新建第一个程序</button>`}>还没有程序<//>`}
				columns=${[
					{ title: "程序", render: (p) => html`<b>${p.name}</b><div class="muted small">${p.id}${p.description ? ` · ${p.description}` : ""}</div>` },
					{
						title: "状态",
						render: (p) => html`${p.enabled ? html`<${Badge} tone="ok">启用<//>` : html`<${Badge}>停用<//>`}
							${p.require_token ? html` <${Badge} tone="warn" title="观众需要访问链接">需链接<//>` : ""}
							${p.allow_commands ? html` <${Badge} tone="bad" title="观众可执行 UE 控制台命令">命令开放<//>` : ""}`,
					},
					{ title: "模式", render: (p) => (p.mode === "shared" ? `共享 · 每实例 ${p.max_viewers} 人` : `独占 · 一人一实例${p.fresh_instance ? " · 用后即关" : ""}`) },
					{ title: "实例", render: (p) => html`${p.runtime?.instances.total ?? 0} / ${p.max_instances}<div class="muted small">预热 ${p.prewarm}${p.prewarm_hours ? `（${p.prewarm_hours} 时）` : ""}</div>` },
					{ title: "观众", render: (p) => html`${p.runtime?.viewers ?? 0}${p.runtime?.queue ? html` <${Badge} tone="warn">排队 ${p.runtime.queue}<//>` : ""}` },
					{ title: "启动方式", class: "wrap", render: (p) => (p.exe ? html`<code class="small">${p.exe}</code>` : html`<span class="muted">接入手动启动的 UE</span>`) },
					{ title: "最近问题", class: "wrap", render: (p) => (p.runtime?.lastError ? html`<span class="text-bad small">${p.runtime.lastError}</span>` : html`<span class="muted">—</span>`) },
					{
						title: "",
						class: "actions",
						render: (p) => html`
							<button class="primary sm" onClick=${() => setAccess(p)} title="播放地址、嵌入代码、访问链接">访问</button>
							${can("operator") && html`<button class="ghost sm" onClick=${() => setEditing({ ...p })}>编辑</button><button class="ghost sm" onClick=${() => toggle(p)}>${p.enabled ? "停用" : "启用"}</button>`}
							${can("admin") && p.id !== "default" && html`<button class="danger sm" onClick=${() => del(p)}>删除</button>`}`,
					},
				]}
			/>
		<//>
		${editing && html`<${Editor} initial=${editing} machines=${s.overview?.machines || []} onClose=${() => setEditing(null)} onSaved=${(p) => (setEditing(null), list.reload(), p && !editing.created_at && setAccess(p))} />`}
		${access && html`<${AccessModal} p=${access} onClose=${() => setAccess(null)} />`}
	`;
}

/** 访问方式：播放地址 / 企业版兼容地址 / 全屏嵌入演示 / iframe 嵌入代码 / 访问链接 */
function AccessModal({ p, onClose }) {
	const [token, setToken] = useState("");
	const [hours, setHours] = useState(24);
	const play = publicUrl(playPath(p.id, token));
	const legacy = publicUrl(legacyPath(p.id, token));
	const demo = publicUrl(`/embed-demo.html?urlPrefix=${encodeURIComponent(p.id)}${token ? `&token=${token}` : ""}`);
	const needToken = p.require_token && !token;
	const makeLink = async () => {
		const l = await run(() => api("POST", "/share-links", { programId: p.id, hours: +hours || 0, note: "访问方式面板生成" }), "已生成访问链接");
		if (l?.path) setToken(new URL(l.path, location.origin).searchParams.get("token"));
	};
	return html`<${Modal} wide title=${`访问方式：${p.name}`} onClose=${onClose} footer=${html`<a class="btn ghost" href=${playPath(p.id, token) + (token ? "&" : "?") + "stats=1"} target="_blank" rel="noopener">在管理口预览</a><button class="primary" onClick=${onClose}>完成</button>`}>
		${!hasPublicBase() && html`<div class="alert warn">未设置「对外访问地址」，以下地址使用的是当前管理口，外网观众无法打开。请到「系统设置 → 访问与嵌入」填写 nginx 对外地址。</div>`}
		${p.require_token &&
		html`<div class="alert info">
			该程序开启了「需要访问链接」：观众必须使用带令牌的地址。${token ? "已为下面的地址附加新生成的访问链接令牌。" : ""}
			${!token &&
			can("operator") &&
			html`<div class="card-actions">
				<label class="check small">有效期 <input type="number" min="0" class="sm" style="width:80px" value=${hours} onInput=${(e) => setHours(e.target.value)} /> 小时（0 = 永久）</label>
				<${AsyncButton} class="primary sm" onClick=${makeLink}>生成访问链接并填入<//>
			</div>`}
		</div>`}
		<h4>播放地址</h4>
		<div class="access-note">直接打开即可观看（http 与 https 均可，取决于对外地址）。</div>
		<${CopyLine} label="推荐地址" value=${play} />
		<${CopyLine} label="企业版兼容" value=${legacy} />
		<${CopyLine} label="全屏演示页" value=${demo} />
		<h4>嵌入到业务系统</h4>
		<div class="access-note">复制到业务系统页面；业务系统是 https 页面时，对外地址也必须是 https 且使用受信任证书。</div>
		<pre class="code">${embedCode(legacy)}</pre>
		<div class="card-actions"><button class="ghost sm" onClick=${() => copyText(embedCode(legacy))} disabled=${needToken}>复制嵌入代码</button></div>
		<h4>可选参数</h4>
		<div class="access-note"><code>stats=1</code> 显示链路状态浮层 · <code>relay=1</code> 强制走 TURN 中继（排查网络问题时使用）</div>
	<//>`;
}

const TABS = [
	["basic", "基本"],
	["launch", "启动与画面"],
	["sched", "调度"],
	["access", "访问控制"],
];

function Editor({ initial, machines, onClose, onSaved }) {
	const isNew = !initial.created_at;
	const [v, setV, bind] = useForm(initial);
	const [tab, setTab] = useState("basic");
	const [err, setErr] = useState("");
	const [ipsText, setIpsText] = useState((initial.allow_ips || []).join(", ")); // 原始文本，保存时再解析（避免输入逗号时被吞掉）
	const idOk = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(v.id || "");
	const save = async () => {
		setErr("");
		if (!idOk) return setTab("basic"), setErr("程序 ID 只能包含小写字母、数字、- 和 _，长度 1-32，以字母或数字开头");
		const { runtime, created_at, updated_at, ...body } = v;
		body.allow_ips = ipsText.split(/[,，\s]+/).filter(Boolean);
		try {
			const saved = isNew ? await api("POST", "/programs", body) : await api("PUT", `/programs/${v.id}`, body);
			onSaved(saved);
			run(async () => 0, isNew ? "已创建，可在弹出的「访问方式」中复制播放地址" : "已保存");
		} catch (e) {
			setErr(e.message);
		}
	};
	const toggleMachine = (id) => setV({ ...v, machines: v.machines.includes(id) ? v.machines.filter((x) => x !== id) : [...v.machines, id] });
	const setOverride = (id, path) => {
		const o = { ...(v.exe_overrides || {}) };
		if (path.trim()) o[id] = path;
		else delete o[id];
		setV({ ...v, exe_overrides: o });
	};
	return html`<${Modal}
		wide
		title=${isNew ? "新建程序" : `编辑程序：${v.name || v.id}`}
		onClose=${onClose}
		onSubmit=${save}
		footer=${html`${err && html`<span class="text-bad small grow">${err}</span>`}<button type="button" class="ghost" onClick=${onClose}>取消</button><${AsyncButton} class="primary" onClick=${save}>${isNew ? "创建" : "保存"}<//>`}
	>
		<${Tabs} tabs=${TABS} value=${tab} onChange=${setTab} />
		<div class="tab-body">
			${tab === "basic" &&
			html`<div class="form-grid">
				<${Field} label="程序 ID *" hint="用于访问地址 /play/ID 与企业版 urlPrefix；小写字母/数字/-/_，创建后不可修改" error=${v.id && !idOk ? "格式不正确" : ""}>
					<input value=${v.id} disabled=${!isNew} placeholder="例如 factory" onInput=${(e) => setV({ ...v, id: e.target.value.trim().toLowerCase() })} autofocus=${isNew} />
				<//>
				<${Field} label="名称" hint="显示在门户首页与播放页标题"><input ...${bind("name")} placeholder="例如 智慧工厂" /><//>
				<${Field} label="描述" class="full"><input ...${bind("description")} placeholder="可选" /><//>
				<${Field} label="UE 版本" hint="auto 自动识别 UE5 像素流 1/2；UE4.27 必须选 4.27">
					<select value=${v.ue_version} onChange=${(e) => setV({ ...v, ue_version: e.target.value })}>
						<option value="auto">自动识别（UE5）</option><option value="5">UE5 像素流 1</option><option value="5.52">UE5.5+ 像素流 2</option><option value="4.27">UE4.27</option>
					</select>
				<//>
				<${Field} label="模式">
					<select value=${v.mode} onChange=${(e) => setV({ ...v, mode: e.target.value, max_viewers: e.target.value === "exclusive" ? 1 : Math.max(2, v.max_viewers) })}>
						<option value="exclusive">独占：一个实例只服务一位观众（可操作）</option>
						<option value="shared">共享：一个实例服务多位观众（观看为主）</option>
					</select>
				<//>
				<label class="check"><input type="checkbox" ...${bind("enabled", "checkbox")} /> 启用（停用后新观众无法进入）</label>
				<label class="check"><input type="checkbox" ...${bind("public", "checkbox")} /> 在观众门户首页展示</label>
			</div>`}
			${tab === "launch" &&
			html`<div class="form-grid">
				<${Field} label="可执行文件路径" hint="渲染机上的完整路径；留空表示只接入手动启动的 UE（-PixelStreamingURL=ws://平台:端口/程序ID）" class="full">
					<input ...${bind("exe")} placeholder="D:\\UEProject\\Factory\\Windows\\Factory.exe" />
				<//>
				<${Field} label="额外启动参数" hint="连接地址、GPU、分辨率、码率等由平台自动生成，这里只填其它参数"><input ...${bind("args")} placeholder="-PixelStreamingEncoderMaxQP=40" /><//>
				<${Field} label="工作目录" hint="默认为可执行文件所在目录"><input ...${bind("cwd")} /><//>
				<div class="row3 full">
					<${Field} label="宽"><input ...${bind("res_x", "number")} min="0" /><//>
					<${Field} label="高"><input ...${bind("res_y", "number")} min="0" /><//>
					<${Field} label="帧率"><input ...${bind("fps", "number")} min="0" /><//>
				</div>
				<div class="row3 full">
					<${Field} label="最大码率 (Mbps)" hint="0 = UE 默认"><input ...${bind("max_bitrate_mbps", "number")} step="0.5" min="0" /><//>
					<${Field} label="最小码率 (Mbps)"><input ...${bind("min_bitrate_mbps", "number")} step="0.5" min="0" /><//>
					<label class="check" style="align-self:center"><input type="checkbox" ...${bind("audio", "checkbox")} /> 启用音频</label>
				</div>
				${machines.length > 0 &&
				html`<${Field} label="不同机器上的安装路径" hint="与默认路径不同时才需要填写；留空 = 使用默认路径" class="full">
					<div class="overrides">
						${machines.map(
							(m) => html`<div class="ovr"><span class="muted small">${m.name}（${m.id}）</span><input class="sm" value=${v.exe_overrides?.[m.id] || ""} placeholder=${v.exe || "该机器上的完整路径"} onInput=${(e) => setOverride(m.id, e.target.value)} /></div>`
						)}
					</div>
				<//>`}
			</div>`}
			${tab === "sched" &&
			html`<div class="form-grid">
				${v.mode === "shared" && html`<${Field} label="每实例最多观众"><input ...${bind("max_viewers", "number")} min="2" /><//>`}
				<${Field} label="最大实例数" hint="该程序同时运行的实例上限"><input ...${bind("max_instances", "number")} min="0" /><//>
				<${Field} label="预热实例数" hint="常备空闲实例，观众秒进；不超过最大实例数"><input ...${bind("prewarm", "number")} min="0" /><//>
				<${Field} label="预热时段" hint='例如 "8-20" 表示 8 点到 20 点预热；空 = 全天'><input ...${bind("prewarm_hours")} placeholder="全天" /><//>
				<${Field} label="空闲释放（秒）" hint=${v.fresh_instance ? "开启「每位观众使用全新实例」后，用过的实例在观众离开时立即关闭；这里只作用于未被使用的实例" : "实例无观众超过该时间自动关闭（预热实例除外）"}><input ...${bind("idle_release_sec", "number")} min="0" /><//>
				<${Field} label="启动超时（秒）" hint="UE 启动后多久内必须连上平台，超时换 GPU 重试"><input ...${bind("startup_timeout_sec", "number")} min="10" /><//>
				<${Field} label="估算显存 (MB)" hint="放置实例时检查剩余显存；0 = 不检查"><input ...${bind("gpu_mem_mb", "number")} min="0" /><//>
				${v.mode !== "shared" &&
				html`<label class="check"><input type="checkbox" ...${bind("fresh_instance", "checkbox")} /> 每位观众使用全新实例：观众离开后立即关闭其实例，不再交给下一位观众（避免上一位观众的场景状态、登录信息残留）。新观众需等待实例启动，建议同时设置预热实例数</label>`}
				<${Field} label="允许运行的机器" hint="不选 = 所有在线机器" class="full">
					<div class="chips">
						${machines.length
							? machines.map((m) => html`<label class="chip ${v.machines.includes(m.id) ? "on" : ""}"><input type="checkbox" checked=${v.machines.includes(m.id)} onChange=${() => toggleMachine(m.id)} />${m.name}</label>`)
							: html`<span class="muted small">暂无已接入的机器</span>`}
					</div>
				<//>
			</div>`}
			${tab === "access" &&
			html`<div class="form-grid">
				<label class="check"><input type="checkbox" ...${bind("require_token", "checkbox")} /> 需要访问链接：观众必须使用「访问链接」页面生成的带令牌地址（可设有效期与次数）</label>
				<label class="check"><input type="checkbox" ...${bind("vip_preempt", "checkbox")} /> VIP 链接满员时抢占：使用 VIP 访问链接的观众总是排在最前；没有可用实例时，断开观看时间最长的普通观众把位置让给 VIP（不勾选则只优先排队）</label>
				<label class="check"><input type="checkbox" ...${bind("one_session_per_ip", "checkbox")} /> 同一 IP 只保留最新会话：新页面打开时断开旧页面（企业 NAT 下多人共用 IP 时不要开启）</label>
				<label class="check"><input type="checkbox" ...${bind("hide_cursor", "checkbox")} /> 播放页隐藏鼠标指针（UE 内自绘光标时使用）</label>
				<label class="check"><input type="checkbox" ...${bind("allow_commands", "checkbox")} /> 允许观众执行 UE 控制台命令 <span class="text-bad small">（-AllowPixelStreamingCommands：任何观众都能执行 quit 等命令，仅在可信内网开启）</span></label>
				<${Field} label="无操作自动断开（秒）" hint="0 = 不限；到时断开并把实例让给其他人"><input ...${bind("inactive_release_sec", "number")} min="0" /><//>
				<${Field} label="只允许这些 IP / 网段" hint="逗号分隔，空 = 不限，例如 10.0.0.0/8, 203.0.113.5">
					<input value=${ipsText} onInput=${(e) => setIpsText(e.target.value)} placeholder="不限" />
				<//>
			</div>`}
		</div>
	<//>`;
}
