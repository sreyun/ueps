import { html, usePoll, api, run, Card, Table, Badge, Modal, Field, useForm, can, useState, confirmDialog, copyText, useStore } from "../lib.js";

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
};

export function Programs() {
	const list = usePoll(() => api("GET", "/programs"), [], 5000);
	const s = useStore();
	const [editing, setEditing] = useState(null);
	const del = (p) => confirmDialog(`确定删除程序「${p.name}」？其运行中的实例会被停止。`) && run(() => api("DELETE", `/programs/${p.id}`), "已删除").then(list.reload);
	const toggle = (p) => run(() => api("PUT", `/programs/${p.id}`, { enabled: !p.enabled }), p.enabled ? "已停用" : "已启用").then(list.reload);
	return html`
		<${Card}
			title="程序"
			extra=${can("operator") && html`<button class="primary" onClick=${() => setEditing({ ...EMPTY })}>新建程序</button>`}
		>
			<p class="muted small">程序 = 一个 UE 打包工程。观众访问 <code>/play/程序ID</code>；平台按需在空闲 GPU 上启动实例，并通过 <code>-PixelStreamingURL</code> 让 UE 精确回连。</p>
			<${Table}
				rows=${list.data}
				empty=${list.loading ? "加载中…" : "还没有程序"}
				columns=${[
					{ title: "程序", render: (p) => html`<b>${p.name}</b><div class="muted small">${p.id}</div>` },
					{ title: "状态", render: (p) => html`${p.enabled ? html`<${Badge} tone="ok">启用<//>` : html`<${Badge}>停用<//>`} ${p.require_token ? html`<${Badge} tone="warn">需链接<//>` : ""}` },
					{ title: "模式", render: (p) => (p.mode === "shared" ? `共享 · 每实例 ${p.max_viewers} 人` : "独占 · 一人一实例") },
					{ title: "实例", render: (p) => html`${p.runtime?.instances.total ?? 0} / ${p.max_instances}<div class="muted small">预热 ${p.prewarm}</div>` },
					{ title: "观众", render: (p) => html`${p.runtime?.viewers ?? 0}${p.runtime?.queue ? html` <${Badge} tone="warn">排队 ${p.runtime.queue}<//>` : ""}` },
					{ title: "启动方式", class: "wrap", render: (p) => (p.exe ? html`<code class="small">${p.exe}</code>` : html`<span class="muted">手动启动的 UE 接入</span>`) },
					{ title: "最近问题", class: "wrap", render: (p) => (p.runtime?.lastError ? html`<span class="text-bad small">${p.runtime.lastError}</span>` : html`<span class="muted">—</span>`) },
					{
						title: "",
						class: "actions",
						render: (p) => html`
							<a class="btn ghost sm" href=${`/play/${encodeURIComponent(p.id)}?stats=1`} target="_blank" rel="noopener">预览</a>
							<button class="ghost sm" onClick=${() => copyText(`/play/${p.id}`)}>复制路径</button>
							${can("operator") && html`<button class="ghost sm" onClick=${() => setEditing({ ...p })}>编辑</button><button class="ghost sm" onClick=${() => toggle(p)}>${p.enabled ? "停用" : "启用"}</button>`}
							${can("admin") && p.id !== "default" && html`<button class="danger sm" onClick=${() => del(p)}>删除</button>`}`,
					},
				]}
			/>
		<//>
		${editing && html`<${Editor} initial=${editing} machines=${s.overview?.machines || []} onClose=${() => setEditing(null)} onSaved=${() => (setEditing(null), list.reload())} />`}
	`;
}

function Editor({ initial, machines, onClose, onSaved }) {
	const isNew = !initial.created_at;
	const [v, setV, bind] = useForm(initial);
	const [err, setErr] = useState("");
	const [ipsText, setIpsText] = useState((initial.allow_ips || []).join(", ")); // 原始文本，保存时再解析（避免输入逗号时被吞掉）
	const save = async () => {
		setErr("");
		const { runtime, created_at, updated_at, ...body } = v;
		body.allow_ips = ipsText.split(/[,，\s]+/).filter(Boolean);
		try {
			if (isNew) await api("POST", "/programs", body);
			else await api("PUT", `/programs/${v.id}`, body);
			onSaved();
			run(async () => 0, "已保存");
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
		title=${isNew ? "新建程序" : `编辑程序：${v.name}`}
		onClose=${onClose}
		footer=${html`${err && html`<span class="text-bad small grow">${err}</span>`}<button class="ghost" onClick=${onClose}>取消</button><button class="primary" onClick=${save}>保存</button>`}
	>
		<div class="form-grid">
			<h4>基本信息</h4>
			<${Field} label="程序 ID" hint="用于访问地址 /play/ID，小写字母/数字/-/_"><input ...${bind("id")} disabled=${!isNew} placeholder="例如 factory" /><//>
			<${Field} label="名称"><input ...${bind("name")} placeholder="例如 智慧工厂" /><//>
			<${Field} label="描述"><input ...${bind("description")} /><//>
			<${Field} label="UE 版本" hint="auto 可自动识别 UE5 像素流1/2；UE4.27 必须选 4.27">
				<select ...${bind("ue_version")} onChange=${(e) => setV({ ...v, ue_version: e.target.value })}>
					<option value="auto">自动识别（UE5）</option><option value="5">UE5 像素流1</option><option value="5.52">UE5.5+ 像素流2</option><option value="4.27">UE4.27</option>
				</select>
			<//>

			<h4>启动</h4>
			<${Field} label="可执行文件路径" hint="渲染机上的完整路径；留空表示只接入手动启动的 UE"><input ...${bind("exe")} placeholder="D:\\UEProject\\Factory\\Windows\\Factory.exe" /><//>
			<${Field} label="额外启动参数" hint="连接地址、GPU、分辨率等由平台自动生成"><input ...${bind("args")} placeholder="-AudioMixer -PixelStreamingEncoderMaxQP=40" /><//>
			<${Field} label="工作目录" hint="默认为可执行文件所在目录"><input ...${bind("cwd")} /><//>
			<div class="row3">
				<${Field} label="宽"><input ...${bind("res_x", "number")} /><//>
				<${Field} label="高"><input ...${bind("res_y", "number")} /><//>
				<${Field} label="帧率"><input ...${bind("fps", "number")} /><//>
			</div>
			<div class="row3">
				<${Field} label="最大码率(Mbps)" hint="0 = UE 默认"><input ...${bind("max_bitrate_mbps", "number")} step="0.5" /><//>
				<${Field} label="最小码率(Mbps)"><input ...${bind("min_bitrate_mbps", "number")} step="0.5" /><//>
				<label class="check"><input type="checkbox" ...${bind("audio", "checkbox")} /> 启用音频</label>
			</div>
			${machines.length > 0 &&
			html`<${Field} label="不同机器上的安装路径" hint="与默认路径不同时才需要填写；留空 = 使用默认路径">
				<div class="overrides">
					${machines.map(
						(m) => html`<div class="ovr"><span class="muted small">${m.name}</span><input class="sm" value=${v.exe_overrides?.[m.id] || ""} placeholder=${v.exe || "该机器上的完整路径"} onInput=${(e) => setOverride(m.id, e.target.value)} /></div>`
					)}
				</div>
			<//>`}

			<h4>调度</h4>
			<${Field} label="模式">
				<select value=${v.mode} onChange=${(e) => setV({ ...v, mode: e.target.value, max_viewers: e.target.value === "exclusive" ? 1 : Math.max(2, v.max_viewers) })}>
					<option value="exclusive">独占：一个实例只服务一位观众（可操作）</option>
					<option value="shared">共享：一个实例服务多位观众（观看为主）</option>
				</select>
			<//>
			${v.mode === "shared" && html`<${Field} label="每实例最多观众"><input ...${bind("max_viewers", "number")} min="2" /><//>`}
			<div class="row3">
				<${Field} label="最大实例数"><input ...${bind("max_instances", "number")} /><//>
				<${Field} label="预热实例数" hint="常备空闲实例，观众秒进"><input ...${bind("prewarm", "number")} /><//>
				<${Field} label="估算显存(MB)" hint="0 = 不按显存判断"><input ...${bind("gpu_mem_mb", "number")} /><//>
			</div>
			<div class="row3">
				<${Field} label="空闲释放(秒)"><input ...${bind("idle_release_sec", "number")} /><//>
				<${Field} label="启动超时(秒)"><input ...${bind("startup_timeout_sec", "number")} /><//>
				<${Field} label="预热时段" hint='例如 "8-20"，空 = 全天'><input ...${bind("prewarm_hours")} placeholder="8-20" /><//>
			</div>
			<${Field} label="允许运行的机器" hint="不选 = 所有在线机器">
				<div class="chips">
					${machines.length
						? machines.map((m) => html`<label class="chip ${v.machines.includes(m.id) ? "on" : ""}"><input type="checkbox" checked=${v.machines.includes(m.id)} onChange=${() => toggleMachine(m.id)} />${m.name}</label>`)
						: html`<span class="muted small">暂无已接入的机器</span>`}
				</div>
			<//>

			<h4>访问</h4>
			<label class="check"><input type="checkbox" ...${bind("enabled", "checkbox")} /> 启用</label>
			<label class="check"><input type="checkbox" ...${bind("public", "checkbox")} /> 在门户首页展示</label>
			<label class="check"><input type="checkbox" ...${bind("require_token", "checkbox")} /> 需要访问链接（在「访问链接」页面生成，可设置有效期与次数）</label>
			<label class="check"><input type="checkbox" ...${bind("one_session_per_ip", "checkbox")} /> 同一 IP 只保留最新会话（新页面打开时断开旧页面）</label>
			<label class="check"><input type="checkbox" ...${bind("hide_cursor", "checkbox")} /> 播放页隐藏鼠标指针（UE 内自绘光标时使用）</label>
			<label class="check"><input type="checkbox" ...${bind("allow_commands", "checkbox")} /> 允许观众执行 UE 控制台命令 <span class="text-bad small">（-AllowPixelStreamingCommands，任何观众都能执行 quit 等命令，仅在可信内网场景开启）</span></label>
			<${Field} label="无操作自动断开(秒)" hint="0 = 不限；到时断开并释放实例给其他人"><input ...${bind("inactive_release_sec", "number")} /><//>
			<${Field} label="只允许这些 IP/网段访问" hint="逗号分隔，空 = 不限，例如 10.0.0.0/8, 203.0.113.5">
				<input value=${ipsText} onInput=${(e) => setIpsText(e.target.value)} placeholder="不限" />
			<//>
		</div>
	<//>`;
}
