import { html, useStore, api, run, Card, Badge, Bar, Modal, Field, fmt, can, useState, useEffect, useRef, confirmDialog, copyText, AsyncButton, Empty, Tabs, toast, store } from "../lib.js";

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
							: html`<div class="muted small" style="grid-column:1/-1">未检测到 NVIDIA GPU（未安装驱动或 nvidia-smi 不可用），按实例数放置；可点下方「设置」手动定义 GPU。</div>`}
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

/* ------------------------------------------------------------------ 接入渲染机 */

const MB = (b) => `${((b || 0) / 1048576).toFixed(1)} MB`;
const SOURCE_LABEL = { upload: "管理员上传", release: "从发布页获取", self: "由平台程序自动生成", manual: "手动放入数据目录" };
const MAGIC = { windows: [0x4d, 0x5a], linux: [0x7f, 0x45, 0x4c, 0x46] };

/** 上传前在浏览器里先检查文件类型，避免把 100MB 的错误文件传完才报错 */
async function checkFile(name, f) {
	const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
	if ((head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0x1f && head[1] === 0x8b)) return "这是压缩包：请上传发布页中单独的安装程序 / 可执行文件，不要上传 zip、tar.gz";
	if (!MAGIC[name].every((b, i) => head[i] === b)) return name === "windows" ? "不是 Windows 程序：请上传 ps-platform-agent-setup-<版本>.exe" : "不是 Linux 可执行文件：请上传 ps-platform-agent-<版本>-linux-x64";
	if (name === "windows") {
		const tail = new TextDecoder().decode(new Uint8Array(await f.slice(f.size - 8).arrayBuffer()));
		if (tail !== "PSAGENT1" && tail !== "PSCONF01") return "这不是 Agent 安装程序（ps-platform.exe 本身不能用）：请上传发布页中的 ps-platform-agent-setup-<版本>.exe";
	}
	return null;
}

function uploadPackage(name, file, onProgress) {
	return new Promise((resolve, reject) => {
		const x = new XMLHttpRequest();
		x.open("PUT", `/api/v1/agent-packages/${name}`);
		x.setRequestHeader("X-PS-Request", "1");
		x.setRequestHeader("Content-Type", "application/octet-stream");
		x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
		x.onload = () => {
			let d = null;
			try {
				d = JSON.parse(x.responseText);
			} catch {}
			if (x.status === 401) store.set({ user: null, overview: null, sessionExpired: true });
			x.status < 300 ? resolve(d) : reject(new Error(d?.error || `上传失败 (${x.status})`));
		};
		x.onerror = () => reject(new Error("上传中断：网络错误，或平台拒绝了连接"));
		x.send(file);
	});
}

/** 安装包状态卡片：来源 / 版本 / 大小，获取与上传进度，管理员可一键从发布页获取或上传 */
function PackageStatus({ name, pk, reload, up, setUp, accept }) {
	const fileRef = useRef();
	if (!pk) return html`<div class="pkg muted small"><span class="spin"></span> 正在读取安装包状态…</div>`;
	const t = pk.targets[name];
	const job = t.job;
	const running = job?.state === "running";
	const u = up[name];
	const fetchIt = () => run(async () => (await api("POST", `/agent-packages/${name}/fetch`), reload()));
	const del = async () =>
		(await confirmDialog({ title: "删除安装包", text: `删除平台上的${t.label}？删除后渲染机将无法从平台下载，直到重新获取或上传。`, okText: "删除" })) &&
		run(async () => (await api("DELETE", `/agent-packages/${name}`), reload()), "已删除");
	const onFile = async (e) => {
		const f = e.target.files[0];
		e.target.value = "";
		if (!f) return;
		const bad = await checkFile(name, f);
		if (bad) return toast(bad, "bad");
		setUp((x) => ({ ...x, [name]: { sent: 0, total: f.size } }));
		try {
			await uploadPackage(name, f, (sent) => setUp((x) => ({ ...x, [name]: { sent, total: f.size } })));
			toast("已上传");
		} catch (er) {
			toast(er.message, "bad");
		} finally {
			setUp((x) => {
				const y = { ...x };
				delete y[name];
				return y;
			});
			reload();
		}
	};
	const stale = t.available && t.version && t.version !== pk.version;
	return html`<div class="pkg">
		<div class="pkg-h">
			<b>${t.label}</b>
			${t.available ? html`<${Badge} tone="ok">可下载<//>` : running ? html`<${Badge} tone="info">${job.kind === "build" ? "正在生成" : "正在获取"}<//>` : html`<${Badge} tone="warn">平台上还没有<//>`}
			${stale && html`<${Badge} tone="warn" title="建议重新获取与平台同版本的安装包">版本 ${t.version}，平台为 ${pk.version}<//>`}
		</div>
		${t.available &&
		html`<div class="muted small">
			${SOURCE_LABEL[t.source] || ""}${t.version ? ` · 版本 ${t.version}` : ""} · ${MB(t.size)} · ${fmt.time(t.updatedAt)}${t.sha256 ? html` · <span title=${t.sha256}>SHA256 ${t.sha256.slice(0, 12)}…</span>` : ""}
		</div>`}
		${!t.available &&
		!running &&
		!u &&
		job?.state !== "error" &&
		html`<div class="muted small">
			${name === "windows" ? "Docker / Linux 部署的平台需要先获取一次 Windows 安装程序。" : "渲染机从平台下载 Linux Agent 前需要先获取一次。"}可点「从发布页获取」，或在能上网的电脑下载
			${pk.releasePage ? html`<a href=${pk.releasePage} target="_blank" rel="noopener">发布页</a>` : "发布页"}中的 <code>${t.asset}</code> 后上传。
		</div>`}
		${running &&
		html`<div class="pkg-p"><${Bar} value=${job.received} max=${job.total || job.received || 1} tone="ok" /><span class="muted small">${job.kind === "build" ? "正在由平台程序生成安装程序（约 10 秒）…" : `正在从发布页下载… ${MB(job.received)}${job.total ? ` / ${MB(job.total)}` : ""}`}</span></div>`}
		${u && html`<div class="pkg-p"><${Bar} value=${u.sent} max=${u.total} tone="ok" /><span class="muted small">正在上传… ${MB(u.sent)} / ${MB(u.total)}</span></div>`}
		${job?.state === "error" && !running && html`<div class="alert bad">获取失败：${job.error}。可在能上网的电脑下载 <code>${t.asset}</code> 后点「上传」。</div>`}
		${can("admin") &&
		html`<div class="row-btns">
			<button class="ghost sm" disabled=${running || !!u || !pk.releaseBaseUrl} title=${pk.releaseBaseUrl ? `${pk.releaseBaseUrl}/${t.asset}` : "未配置发布页地址"} onClick=${fetchIt}>${t.available ? "重新从发布页获取" : "从发布页获取"}</button>
			<button class="ghost sm" disabled=${running || !!u} onClick=${() => fileRef.current.click()}>上传…</button>
			${t.available && t.source !== "self" && html`<button class="ghost sm danger-text" onClick=${del}>删除</button>`}
			<input type="file" ref=${fileRef} accept=${accept} hidden onChange=${onFile} />
		</div>`}
	</div>`;
}

function WindowsTab({ info, pk, ...rest }) {
	const ready = !!pk?.targets.windows.available;
	const link = () => api("POST", "/agent-setup-link");
	const copyLink = async () => {
		const r = await run(link);
		if (r) copyText(r.url);
	};
	const download = async () => {
		const r = await run(link);
		if (r) location.href = r.url;
	};
	return html`
		<ol class="steps">
			<li>
				<b>获取安装程序：</b>复制安装链接，在渲染机的浏览器中打开即可下载。安装程序已包含本平台地址 <code>${info.address}</code> 与接入令牌，链接 24 小时内有效；也可以直接下载后用 U 盘或共享文件夹拷贝到渲染机。
				<div class="row-btns">
					${info.token
						? html`<${AsyncButton} class="primary" disabled=${!ready} onClick=${copyLink}>复制安装链接<//><${AsyncButton} disabled=${!ready} onClick=${download}>直接下载<//>`
						: html`<span class="muted small">安装程序包含接入令牌，只有管理员可以生成下载链接。</span>`}
				</div>
			</li>
			<li><b>在渲染机上双击运行</b>，按提示点「下一步」：确认平台地址 → 填写机器名称、选择 UE 程序所在文件夹 → 选择运行方式 → 安装。</li>
			<li>安装完成后本机自动出现在「渲染机 / GPU」列表中。修改设置可再次运行安装程序；卸载在 Windows「设置 → 应用」中进行。</li>
		</ol>
		<${PackageStatus} name="windows" pk=${pk} accept=".exe" ...${rest} />
		<div class="alert info small">支持 Windows 10 / 11（需管理员权限）。首次运行若出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」（安装程序未做代码签名）。</div>`;
}

function LinuxTab({ info, pk, ...rest }) {
	const cmd = `${info.linuxDownload}\n${info.linux}`;
	return html`
		<ol class="steps">
			<li>
				在 Linux 渲染机上执行（下载 Agent 并连接本平台）：
				<pre class="code">${cmd}</pre>
				<button class="ghost sm" disabled=${!pk?.targets.linux.available} onClick=${() => copyText(cmd)}>复制命令</button>
			</li>
			<li>把 <code>--id</code> 改成机器名、<code>--allow-exe</code> 改成 UE 所在目录。开机自启用 systemd，见安装手册第 5 节。</li>
		</ol>
		<${PackageStatus} name="linux" pk=${pk} ...${rest} />`;
}

function CliTab({ info }) {
	const win = `${info.windowsDownload}\n${info.windows}`;
	return html`
		<h4>Windows 静默安装（批量部署）</h4>
		<p class="small">用「复制安装链接」下载的安装程序（已包含平台地址与令牌），在渲染机的 PowerShell 中以管理员身份执行：</p>
		<pre class="code">${info.windowsSilent}</pre>
		<button class="ghost sm" onClick=${() => copyText(info.windowsSilent)}>复制命令</button>
		<p class="muted small">
			可选参数：<code>/id=机器名</code>（默认为计算机名）、<code>/allow-exe=目录</code>（多个用 <code>;</code> 分隔，路径含空格时把整个参数写成 <code>'"/allow-exe=D:\\UE Project"'</code>）、<code>/mode=logon</code>（登录 Windows 后运行；默认为开机自动运行的 Windows 服务）、<code>/dir=安装位置</code>。结果记录在 <code>%TEMP%\\ps-platform-agent-setup.log</code>。
		</p>
		<h4>Windows 命令行运行（不安装）</h4>
		<pre class="code">${win}</pre>
		<button class="ghost sm" onClick=${() => copyText(win)}>复制命令</button>
		<p class="muted small">在 PowerShell 中执行；关闭窗口即停止。也可用 Node.js ≥ 22 运行源码中的 <code>agent/agent.js</code>。</p>`;
}

function InstallModal({ info, onClose }) {
	const [tab, setTab] = useState("windows");
	const [pk, setPk] = useState(null);
	const [up, setUp] = useState({});
	const reload = async () => {
		try {
			setPk(await api("GET", "/agent-packages"));
		} catch (e) {
			toast(e.message, "bad");
		}
	};
	useEffect(() => {
		reload();
	}, []);
	const busy = !!pk && Object.values(pk.targets).some((t) => t.job?.state === "running");
	useEffect(() => {
		if (!busy) return;
		const t = setInterval(reload, 1200);
		return () => clearInterval(t);
	}, [busy]);
	const rotate = async () => {
		if (!(await confirmDialog({ title: "轮换 Agent 令牌", text: "轮换后旧令牌立即失效：所有渲染机上的 Agent 都需要用新令牌重新连接（Windows 渲染机重新下载安装程序运行一次即可），否则将断开且无法重连。确定轮换？", okText: "轮换" }))) return;
		if (await run(() => api("POST", "/agent-token/rotate"), "令牌已更新：之前复制的安装链接和命令已失效，请重新复制")) onClose();
	};
	const pass = { info, pk, reload, up, setUp };
	return html`<${Modal} wide title="接入渲染机" onClose=${onClose} footer=${html`${can("admin") && info.token && html`<button class="danger" onClick=${rotate}>轮换令牌</button>`}<span class="grow"></span><button class="primary" onClick=${onClose}>完成</button>`}>
		<${Tabs} tabs=${[["windows", "Windows（图形安装）"], ["linux", "Linux"], ["cli", "命令行 / 批量部署"]]} value=${tab} onChange=${setTab} />
		<div class="tab-body">
			${!info.token && tab !== "windows" && html`<div class="alert warn">只有管理员可以查看接入令牌，下面的命令中令牌已隐藏。</div>`}
			${tab === "windows" && html`<${WindowsTab} ...${pass} />`}
			${tab === "linux" && html`<${LinuxTab} ...${pass} />`}
			${tab === "cli" && html`<${CliTab} info=${info} />`}
		</div>
		<p class="muted small">地址取自你当前访问管理端的地址（<code>${info.address}</code>），渲染机需要能访问它（内网）。平台只接受来自「UE/Agent 允许网段」且令牌正确的连接。</p>
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
		<div class="field">
			<span class="field-l">手动定义 GPU</span>
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
			<span class="field-h">无法自动检测显卡时（国产/AMD 显卡、未装 nvidia-smi）在此填写，平台按程序的估算显存分配；能自动检测时以实时数据为准</span>
		</div>
	<//>`;
}
