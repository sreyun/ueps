import { html, useStore, api, run, Card, Badge, Bar, Modal, Field, fmt, can, useState, confirmDialog, copyText, AsyncButton, Empty } from "../lib.js";

export function Machines() {
	const s = useStore();
	const [install, setInstall] = useState(null);
	const [edit, setEdit] = useState(null);
	const machines = s.overview?.machines || [];
	const instances = s.overview?.instances || [];
	const showInstall = async () => {
		const r = await run(() => api("GET", "/agent-install"));
		if (r) setInstall(r);
	};
	const toggle = async (m) => {
		if (m.enabled && !(await confirmDialog({ title: "停用渲染机", text: `停用 ${m.name} 后不再在其上启动新实例，已运行的实例不受影响。确定停用？`, okText: "停用" }))) return;
		run(() => api("PUT", `/machines/${m.id}`, { enabled: !m.enabled }), m.enabled ? "已停用：不再在该机器上启动新实例" : "已启用");
	};
	const del = async (m) =>
		(await confirmDialog({ title: "删除渲染机", text: `确定删除离线机器 ${m.name}（${m.id}）的登记信息？\n该机器的 Agent 再次上线时会自动重新登记。`, okText: "删除" })) && run(() => api("DELETE", `/machines/${m.id}`), "已删除");
	if (!s.overview) return html`<div class="boot"><span class="spin"></span> 加载中…</div>`;
	return html`
		<div class="toolbar">
			<span class="muted">每台渲染机运行一个 Agent（单机部署时平台已内置"本机"Agent）。Agent 上报 GPU 与进程状态，平台据此放置实例。</span>
			${can("operator") && html`<button class="primary" onClick=${showInstall}>＋ 接入渲染机</button>`}
		</div>
		${!machines.length && html`<div class="card"><${Empty} action=${can("operator") && html`<button class="primary" onClick=${showInstall}>查看接入方法</button>`}>还没有渲染机接入<//></div>`}
		<div class="machine-grid">
			${machines.map((m) => {
				const onIt = instances.filter((i) => i.machineId === m.id);
				return html`<${Card}
					key=${m.id}
					title=${html`${m.name} <span class="muted small">${m.id}</span>`}
					extra=${html`${m.online ? html`<${Badge} tone="ok">在线<//>` : html`<${Badge} tone="bad">离线<//>`} ${!m.enabled ? html`<${Badge} tone="warn">已停用<//>` : ""} ${m.local ? html`<${Badge} tone="info">本机<//>` : ""} ${m.legacy ? html`<${Badge} tone="warn">旧版 exec-ue<//>` : ""}`}
				>
					<div class="kv">
						<span>系统</span><span>${m.platform || "-"}</span>
						<span>地址</span><span>${m.host || "-"}</span>
						<span>Agent 版本</span><span>${m.version || "-"}</span>
						<span>实例上限</span><span>${m.max_instances || "不限"}</span>
						<span>最后上报</span><span>${m.online ? "实时" : fmt.time(m.last_seen_at)}</span>
					</div>
					${m.online &&
					html`<div class="meters">
						<div><label>CPU ${m.cpu ?? "-"}%（${m.cpus || "-"} 核）</label><${Bar} value=${m.cpu} /></div>
						<div><label>内存 ${fmt.mb(m.memUsedMB)} / ${fmt.mb(m.memTotalMB)}</label><${Bar} value=${m.memUsedMB} max=${m.memTotalMB} /></div>
					</div>`}
					<div class="gpus">
						${(m.gpus || []).length
							? m.gpus.map(
									(g) => html`<div class="gpu">
										<div class="gpu-h"><b>GPU ${g.index}</b> <span class="muted small">${g.name || ""}${g.manual ? "（手动定义）" : ""}</span>${g.temp ? html`<span class="small"> · ${g.temp}°C</span>` : ""}</div>
										${!g.manual && html`<label>利用率 ${g.util ?? "-"}%</label><${Bar} value=${g.util} />`}
										<label>显存 ${g.manual ? fmt.mb(g.memTotalMB) : `${fmt.mb(g.memUsedMB)} / ${fmt.mb(g.memTotalMB)}`}</label>${!g.manual && html`<${Bar} value=${g.memUsedMB} max=${g.memTotalMB} />`}
										<div class="muted small">实例 ${onIt.filter((i) => i.gpu === g.index).length}</div>
									</div>`
							  )
							: html`<div class="muted small" style="grid-column:1/-1">未检测到 NVIDIA GPU（未安装驱动或 nvidia-smi 不可用），按实例数放置；可在「设置」中手动定义 GPU。</div>`}
					</div>
					<div class="muted small">运行中的实例：${onIt.length ? onIt.map((i) => html`<code>${i.id}</code> `) : "无"}</div>
					${can("operator") &&
					html`<div class="card-actions">
						<button class="ghost sm" onClick=${() => setEdit(m)}>设置</button>
						<button class="ghost sm" onClick=${() => toggle(m)}>${m.enabled ? "停用" : "启用"}</button>
						${can("admin") && !m.online && html`<button class="danger sm" onClick=${() => del(m)}>删除</button>`}
					</div>`}
				<//>`;
			})}
		</div>
		${install && html`<${InstallModal} info=${install} onClose=${() => setInstall(null)} />`}
		${edit && html`<${EditModal} m=${edit} onClose=${() => setEdit(null)} />`}
	`;
}

function InstallModal({ info, onClose }) {
	const rotate = async () => {
		if (!(await confirmDialog({ title: "轮换 Agent 令牌", text: "轮换后旧令牌立即失效：所有渲染机上的 Agent 都需要用新令牌重新启动，否则将断开且无法重连。确定轮换？", okText: "轮换" }))) return;
		if (await run(() => api("POST", "/agent-token/rotate"), "令牌已更新，请重新打开本窗口复制新命令并重启各渲染机的 Agent")) onClose();
	};
	return html`<${Modal} wide title="接入渲染机" onClose=${onClose} footer=${html`${can("admin") && html`<button class="danger" onClick=${rotate}>轮换令牌</button>`}<span class="grow"></span><button class="primary" onClick=${onClose}>完成</button>`}>
		${!info.token && html`<div class="alert warn">只有管理员可以查看 Agent 令牌，下面的命令中令牌已隐藏。</div>`}
		<ol class="steps">
			<li>把发布包复制到渲染机：Windows 用 <code>ps-platform.exe</code>，Linux 用 <code>ps-platform</code>（无扩展名，需可执行权限）；也可用 Node.js ≥ 22 运行源码中的 <code>agent/agent.js</code>。</li>
			<li>
				Windows 渲染机执行（建议用 NSSM 注册为服务，开机自启）：
				<pre class="code">${info.windows}</pre>
				<button class="ghost sm" onClick=${() => copyText(info.windows)}>复制命令</button>
			</li>
			<li>
				Linux 渲染机（在解压目录中执行）：
				<pre class="code">${info.linux}</pre>
				<button class="ghost sm" onClick=${() => copyText(info.linux)}>复制命令</button>
			</li>
			<li>把 <code>--id</code> 改成机器名、<code>--allow-exe</code> 改成 UE 所在目录（只允许启动该目录下的程序，强烈建议设置）。Agent 上线后会出现在本页。</li>
		</ol>
		<p class="muted small">命令中的地址取自你当前访问管理端的地址；渲染机需要能访问它（内网）。平台只接受来自「UE/Agent 允许网段」且令牌正确的连接。</p>
	<//>`;
}

function EditModal({ m, onClose }) {
	const [name, setName] = useState(m.name);
	const [max, setMax] = useState(m.max_instances || 0);
	const [gpus, setGpus] = useState(m.gpus_override || []);
	const save = async () => {
		if (await run(() => api("PUT", `/machines/${m.id}`, { name: name.trim() || m.id, max_instances: Math.max(0, Math.floor(+max) || 0), gpus_override: gpus.filter((g) => g.memTotalMB > 0) }), "已保存")) onClose();
	};
	const setGpu = (i, patch) => setGpus(gpus.map((g, j) => (j === i ? { ...g, ...patch } : g)));
	return html`<${Modal} title=${`渲染机设置：${m.id}`} onClose=${onClose} footer=${html`<button class="ghost" onClick=${onClose}>取消</button><${AsyncButton} class="primary" onClick=${save}>保存<//>`}>
		<${Field} label="显示名称"><input value=${name} maxlength="64" onInput=${(e) => setName(e.target.value)} /><//>
		<${Field} label="最多实例数" hint="0 = 不限制（仍受显存约束）"><input type="number" min="0" value=${max} onInput=${(e) => setMax(e.target.value)} /><//>
		<${Field} label="手动定义 GPU" hint="无法自动检测显卡时（国产/AMD 显卡、未装 nvidia-smi）在此填写，平台按程序的估算显存分配；能自动检测时以实时数据为准">
			<div>
				${gpus.map(
					(g, i) => html`<div class="gpu-row">
						<span class="muted small">GPU ${g.index}</span>
						<input class="sm" placeholder="型号" value=${g.name || ""} onInput=${(e) => setGpu(i, { name: e.target.value })} />
						<input class="sm" type="number" min="0" placeholder="显存 MB" value=${g.memTotalMB || ""} onInput=${(e) => setGpu(i, { memTotalMB: +e.target.value || 0 })} />
						<button class="ghost sm" onClick=${() => setGpus(gpus.filter((_, j) => j !== i).map((x, k) => ({ ...x, index: k })))}>删除</button>
					</div>`
				)}
				<button class="ghost sm" onClick=${() => setGpus([...gpus, { index: gpus.length, name: "", memTotalMB: 8192 }])}>＋ 添加 GPU</button>
			</div>
		<//>
	<//>`;
}
