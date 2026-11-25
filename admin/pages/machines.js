import { html, useStore, api, run, Card, Badge, Bar, Modal, Field, fmt, can, useState, confirmDialog, copyText } from "../lib.js";

export function Machines() {
	const s = useStore();
	const [install, setInstall] = useState(null);
	const [edit, setEdit] = useState(null);
	const machines = s.overview?.machines || [];
	const instances = s.overview?.instances || [];
	const showInstall = async () => setInstall(await run(() => api("GET", "/agent-install")));
	const toggle = (m) => run(() => api("PUT", `/machines/${m.id}`, { enabled: !m.enabled }), m.enabled ? "已停用：不再在该机器上启动新实例" : "已启用");
	const del = (m) => confirmDialog(`确定删除离线机器 ${m.name}？`) && run(() => api("DELETE", `/machines/${m.id}`), "已删除");
	return html`
		<div class="toolbar">
			<span class="muted">每台渲染机运行一个 Agent（单机部署时平台已内置"本机"Agent）。Agent 上报 GPU 与进程状态，平台据此放置实例。</span>
			${can("operator") && html`<button class="primary" onClick=${showInstall}>接入渲染机</button>`}
		</div>
		${!machines.length && html`<div class="card"><div class="card-b empty">还没有渲染机接入。点击右上角「接入渲染机」查看安装命令。</div></div>`}
		<div class="machine-grid">
			${machines.map((m) => {
				const onIt = instances.filter((i) => i.machineId === m.id);
				return html`<${Card}
					key=${m.id}
					title=${html`${m.name} <span class="muted small">${m.id}</span>`}
					extra=${html`${m.online ? html`<${Badge} tone="ok">在线<//>` : html`<${Badge} tone="bad">离线<//>`} ${!m.enabled ? html`<${Badge}>已停用<//>` : ""} ${m.local ? html`<${Badge} tone="info">本机<//>` : ""} ${m.legacy ? html`<${Badge} tone="warn">旧版 exec-ue<//>` : ""}`}
				>
					<div class="kv">
						<span>系统</span><span>${m.platform || "-"}</span>
						<span>地址</span><span>${m.host || "-"}</span>
						<span>Agent</span><span>${m.version || "-"}</span>
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
										<div class="gpu-h"><b>GPU ${g.index}</b> <span class="muted small">${g.name || ""}</span>${g.temp ? html`<span class="small"> · ${g.temp}°C</span>` : ""}</div>
										<label>利用率 ${g.util ?? "-"}%</label><${Bar} value=${g.util} />
										<label>显存 ${fmt.mb(g.memUsedMB)} / ${fmt.mb(g.memTotalMB)}</label><${Bar} value=${g.memUsedMB} max=${g.memTotalMB} />
										<div class="muted small">实例 ${onIt.filter((i) => i.gpu === g.index).length}</div>
									</div>`
							  )
							: html`<div class="muted small">未检测到 NVIDIA GPU（未安装驱动或 nvidia-smi 不可用），按实例数放置。</div>`}
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
		if (!confirmDialog("轮换后所有已接入的 Agent 需要用新令牌重新启动，确定？")) return;
		const r = await run(() => api("POST", "/agent-token/rotate"), "令牌已更新");
		if (r) info.token = r.token;
		onClose();
	};
	return html`<${Modal} wide title="接入渲染机" onClose=${onClose} footer=${html`${can("admin") && html`<button class="danger" onClick=${rotate}>轮换令牌</button>`}<button class="primary" onClick=${onClose}>完成</button>`}>
		<ol class="steps">
			<li>把 <code>ps-platform.exe</code>（或 Node.js + <code>agent/agent.js</code>）复制到渲染机。</li>
			<li>
				Windows 渲染机执行（建议用 NSSM 注册为服务，开机自启）：
				<pre class="code">${info.windows}</pre>
				<button class="ghost sm" onClick=${() => copyText(info.windows)}>复制</button>
			</li>
			<li>
				Linux 渲染机：
				<pre class="code">${info.linux}</pre>
				<button class="ghost sm" onClick=${() => copyText(info.linux)}>复制</button>
			</li>
			<li>Agent 上线后会出现在本页。<code>--allow-exe</code> 限定只能启动指定目录下的程序，强烈建议设置。</li>
		</ol>
		${!info.token && html`<div class="alert warn">只有管理员可以查看 Agent 令牌。</div>`}
		<p class="muted small">Agent 只应连接内网地址；平台只接受来自「UE/Agent 允许网段」且令牌正确的连接。</p>
	<//>`;
}

function EditModal({ m, onClose }) {
	const [name, setName] = useState(m.name);
	const [max, setMax] = useState(m.max_instances || 0);
	const [gpus, setGpus] = useState(m.gpus_override || []);
	const save = async () => {
		await run(() => api("PUT", `/machines/${m.id}`, { name, max_instances: +max || 0, gpus_override: gpus.filter((g) => g.memTotalMB > 0) }), "已保存");
		onClose();
	};
	const setGpu = (i, patch) => setGpus(gpus.map((g, j) => (j === i ? { ...g, ...patch } : g)));
	return html`<${Modal} title=${`机器设置：${m.id}`} onClose=${onClose} footer=${html`<button class="ghost" onClick=${onClose}>取消</button><button class="primary" onClick=${save}>保存</button>`}>
		<${Field} label="名称"><input value=${name} onInput=${(e) => setName(e.target.value)} /><//>
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
				<button class="ghost sm" onClick=${() => setGpus([...gpus, { index: gpus.length, name: "", memTotalMB: 8192 }])}>+ 添加 GPU</button>
			</div>
		<//>
	<//>`;
}
