import { html, useStore, api, run, Card, Badge, Bar, Modal, Field, fmt, can, useState, useEffect, useRef, confirmDialog, AsyncButton, Empty, Tabs, toast, store, Icon, Alert, CopyButton, CopyLine, Cmd } from "../lib.js";

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
	const online = machines.filter((m) => m.online).length;
	return html`
		<div class="toolbar">
			<span class="muted">每台渲染机运行一个 Agent（单机部署时平台已内置"本机"Agent），上报 GPU 与进程状态，平台据此放置实例。${machines.length ? html` 在线 <b>${online}</b> / ${machines.length} 台。` : ""}</span>
			${can("operator") && html`<button class="primary" onClick=${showInstall}><${Icon} name="plus" />接入渲染机</button>`}
		</div>
		${!machines.length && html`<div class="card"><${Empty} icon="server" action=${can("operator") && html`<button class="primary" onClick=${showInstall}>查看接入方法</button>`}>还没有渲染机接入<//></div>`}
		<div class="machine-grid">
			${machines.map((m) => {
				const onIt = instances.filter((i) => i.machineId === m.id);
				return html`<${Card}
					key=${m.id}
					title=${html`<span class="machine-h"><span class=${"machine-ico " + (m.online ? "on" : "off")}><${Icon} name="server" size=${18} /></span><span>${m.name}<span class="card-sub">${m.id}${m.host ? ` · ${m.host}` : ""}</span></span></span>`}
					extra=${html`${m.online ? html`<${Badge} tone="ok" class="dot">在线<//>` : html`<${Badge} tone="bad">离线<//>`} ${!m.enabled ? html`<${Badge} tone="warn">已停用<//>` : ""} ${m.local ? html`<${Badge} tone="info">本机<//>` : ""} ${m.legacy ? html`<${Badge} tone="warn">旧版 exec-ue<//>` : ""}`}
				>
					<div class="kv">
						<span>系统</span><span>${m.platform || "-"}</span>
						<span>Agent 版本</span><span>${m.version || "-"}</span>
						<span>实例上限</span><span>${m.max_instances || "不限"}</span>
						<span>最后上报</span><span>${m.online ? "实时" : fmt.time(m.last_seen_at)}</span>
					</div>
					${m.online &&
					html`<div class="meters">
						<div><label><span>CPU（${m.cpus || "-"} 核）</span><span>${m.cpu ?? "-"}%</span></label><${Bar} value=${m.cpu} /></div>
						<div><label><span>内存</span><span>${fmt.mb(m.memUsedMB)} / ${fmt.mb(m.memTotalMB)}</span></label><${Bar} value=${m.memUsedMB} max=${m.memTotalMB} /></div>
					</div>`}
					${(m.gpus || []).length
						? html`<div class="gpus">
								${m.gpus.map(
									(g) => html`<div class="gpu">
										<div class="gpu-h"><b>GPU ${g.index}</b> <span class="muted small">${g.name || ""}${g.manual ? "（手动定义）" : ""}</span>${g.temp ? html`<span class="small muted"> · ${g.temp}°C</span>` : ""}</div>
										${!g.manual && html`<label><span>利用率</span><span>${g.util ?? "-"}%</span></label><${Bar} value=${g.util} />`}
										<label><span>显存</span><span>${g.manual ? fmt.mb(g.memTotalMB) : `${fmt.mb(g.memUsedMB)} / ${fmt.mb(g.memTotalMB)}`}</span></label>${!g.manual && html`<${Bar} value=${g.memUsedMB} max=${g.memTotalMB} />`}
										<div class="muted small">实例 ${onIt.filter((i) => i.gpu === g.index).length}</div>
									</div>`
								)}
							</div>`
						: html`<div class="note">未检测到 NVIDIA GPU（未安装驱动或 nvidia-smi 不可用），按实例数放置；可点下方「设置」手动定义 GPU。</div>`}
					<div class="muted small" style="margin-top:10px">运行中的实例：${onIt.length ? onIt.map((i) => html`<code>${i.id}</code> `) : "无"}</div>
					${can("operator") &&
					html`<div class="card-actions">
						<button class="ghost sm" onClick=${() => setEdit(m)}><${Icon} name="settings" size=${14} />设置</button>
						<button class="ghost sm" onClick=${() => toggle(m)}>${m.enabled ? "停用" : "启用"}</button>
						${can("admin") && !m.online && html`<button class="ghost sm danger-text" onClick=${() => del(m)}><${Icon} name="trash" size=${14} />删除</button>`}
					</div>`}
				<//>`;
			})}
		</div>
		${install && html`<${InstallModal} initial=${install} onClose=${() => setInstall(null)} />`}
		${edit && html`<${EditModal} m=${edit} onClose=${() => setEdit(null)} />`}
	`;
}

/* ------------------------------------------------------------------ 接入渲染机 */

const MB = (b) => `${((b || 0) / 1048576).toFixed(1)} MB`;
const SOURCE_LABEL = { upload: "管理员上传", release: "从发布页获取", self: "由平台程序自动生成", manual: "手动放入数据目录" };
const MAGIC = { windows: [0x4d, 0x5a], linux: [0x7f, 0x45, 0x4c, 0x46] };

/** 与平台一致的机器 ID 规则：小写字母、数字、- 和 _，最多 48 个字符 */
const sanitizeId = (v) =>
	String(v || "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.slice(0, 48);
/** 目录去掉末尾的 \ 或 /（"D:\UE\" 在命令行中 \" 会被当成转义的引号）；盘符根目录与 / 保留 */
const cleanDir = (d) => {
	const s = String(d || "").trim();
	return /^[a-z]:[\\/]?$/i.test(s) || s === "/" ? s : s.replace(/[\\/]+$/, "");
};
const psArg = (v) => (/^[\w.:\\/-]+$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`);
const shArg = (v) => (/^[\w.:/-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/** 按参数生成各平台命令；id 为空时不传 --id（Agent 默认使用计算机名） */
function commands(info, p) {
	const tok = info.token || "<令牌（管理员可见）>";
	const id = sanitizeId(p.id);
	const win = cleanDir(p.winDir);
	const lin = cleanDir(p.linuxDir);
	const base = `--agent --url ${info.url} --token ${tok}${id ? ` --id ${id}` : ""}`;
	const linuxRun = `./ps-platform ${base}${lin ? ` --allow-exe ${shArg(lin)}` : ""}`;
	// Start-Process 不会给含空格的参数加引号：整个参数写成 '"/allow-exe=D:\UE Project"'
	const silentArgs = ["/S", id && `/id=${id}`, win && `/allow-exe=${win}`].filter(Boolean).map((a) => (/\s/.test(a) ? `'"${a.replace(/'/g, "''")}"'` : `'${a.replace(/'/g, "''")}'`));
	return {
		linux: `curl -fL -o ps-platform ${info.downloads.linux} && chmod +x ps-platform\n${linuxRun}`,
		windowsRun: `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri ${info.downloads.windowsExe} -OutFile ps-platform.exe\n.\\ps-platform.exe ${base}${win ? ` --allow-exe ${psArg(win)}` : ""}`,
		windowsSilent: `Start-Process -Wait .\\ps-platform-agent-setup.exe -ArgumentList ${silentArgs.join(",")}`,
		systemd: `sudo install -D -m 755 ps-platform /opt/ps-agent/ps-platform
sudo tee /etc/systemd/system/ps-platform-agent.service >/dev/null <<EOF
[Unit]
Description=ps-platform agent
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
ExecStart=/opt/ps-agent/${linuxRun.slice(2)}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now ps-platform-agent`,
	};
}

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

/** 安装包状态：可下载时显示来源 / 版本 / 大小；没有时给出获取方式（从发布页获取或上传），带进度与失败原因 */
function PackageStatus({ name, pk, reload, up, setUp, accept }) {
	const fileRef = useRef();
	if (!pk) return html`<div class="pkg muted small"><span class="spin"></span> 正在读取安装包状态…</div>`;
	const t = pk.targets[name];
	const job = t.job;
	const running = job?.state === "running";
	const u = up[name];
	const admin = can("admin");
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
	const releaseLink = pk.releasePage ? html`<a href=${pk.releasePage} target="_blank" rel="noopener">发布页 <${Icon} name="external" size=${12} /></a>` : "发布页";
	const fetchBtn = (primary) =>
		html`<button class=${primary ? "primary sm" : "ghost sm"} disabled=${running || !!u || !pk.releaseBaseUrl} title=${pk.releaseBaseUrl ? `${pk.releaseBaseUrl}/${t.asset}` : "未配置发布页地址（config.json 的 downloads.releaseBaseUrl）"} onClick=${fetchIt}><${Icon} name=${t.available ? "refresh" : "download"} size=${14} />${t.available ? "重新获取" : "从发布页获取"}</button>`;
	const uploadBtn = html`<button class="ghost sm" disabled=${running || !!u} onClick=${() => fileRef.current.click()}><${Icon} name="upload" size=${14} />上传…</button><input type="file" ref=${fileRef} accept=${accept} hidden onChange=${onFile} />`;
	return html`<div class="pkg">
		<div class="pkg-h">
			<b>${t.label}</b>
			${t.available ? html`<${Badge} tone="ok" class="dot">可下载<//>` : running ? html`<${Badge} tone="info">${job.kind === "build" ? "正在生成" : "正在获取"}<//>` : u ? html`<${Badge} tone="info">正在上传<//>` : html`<${Badge} tone="warn">尚未准备<//>`}
			${stale && html`<${Badge} tone="warn" title="建议重新获取与平台同版本的安装包">版本 ${t.version}，平台为 ${pk.version}<//>`}
		</div>
		${t.available &&
		html`<div class="pkg-meta">
			${SOURCE_LABEL[t.source] || ""}${t.version ? ` · 版本 ${t.version}` : ""} · ${MB(t.size)} · ${fmt.time(t.updatedAt)}${t.sha256 ? html` · <span title=${t.sha256}>SHA256 ${t.sha256.slice(0, 12)}…</span>` : ""}
		</div>`}
		${!t.available &&
		!running &&
		!u &&
		html`<div class="pkg-meta">
			${name === "windows" ? "平台以 Windows 程序运行时会自动生成；Docker / Linux 部署的平台需要获取一次。" : "平台以 Linux 程序运行时直接提供自身；其它部署方式需要获取一次。"}
			${!admin ? "请联系管理员准备。" : pk.releaseBaseUrl ? html`可从${releaseLink}自动获取，或在能上网的电脑下载 <code>${t.asset}</code> 后上传。` : html`未配置发布页地址（<code>downloads.releaseBaseUrl</code>），请在能上网的电脑下载 <code>${t.asset}</code> 后上传。`}
		</div>`}
		${running &&
		html`<div class="pkg-p"><${Bar} value=${job.received} max=${job.total || job.received || 1} tone="ok" /><span class="muted small">${job.kind === "build" ? "正在由平台程序生成安装程序（约 10 秒）…" : `正在从发布页下载… ${MB(job.received)}${job.total ? ` / ${MB(job.total)}` : ""}`}</span></div>`}
		${u && html`<div class="pkg-p"><${Bar} value=${u.sent} max=${u.total} tone="ok" /><span class="muted small">正在上传… ${MB(u.sent)} / ${MB(u.total)}</span></div>`}
		${job?.state === "error" && !running && !t.available && html`<${Alert} tone="bad">获取失败：${job.error}。可在能上网的电脑从${releaseLink}下载 <code>${t.asset}</code> 后点「上传」。<//>`}
		${admin &&
		html`<div class="row-btns">
			${pk.releaseBaseUrl ? fetchBtn(!t.available) : ""} ${uploadBtn}
			${t.available && t.source !== "self" && html`<button class="ghost sm danger-text" onClick=${del}><${Icon} name="trash" size=${14} />删除</button>`}
		</div>`}
	</div>`;
}

/** 渲染机参数：填写后下方命令自动更新 */
function Params({ params, setParams, dirKey, dirHint }) {
	const set = (k) => (e) => setParams((p) => ({ ...p, [k]: e.target.value }));
	const id = sanitizeId(params.id);
	return html`<div class="params">
		<${Field} label="机器名称（--id）" hint=${params.id && id !== params.id ? `将使用：${id || "（计算机名）"}` : "留空 = 使用计算机名；小写字母、数字、- 和 _，每台渲染机不同"}>
			<input value=${params.id} placeholder="留空则使用计算机名" maxlength="64" spellcheck="false" onInput=${set("id")} />
		<//>
		<${Field} label="UE 程序所在目录（--allow-exe）" hint=${dirHint}>
			<input value=${params[dirKey]} spellcheck="false" onInput=${set(dirKey)} />
		<//>
	</div>`;
}

/** 安装期间实时显示新接入的渲染机 */
function JoinWatch({ since }) {
	const s = useStore();
	const joined = (s.overview?.machines || []).filter((m) => m.online && !since.has(m.id));
	return joined.length
		? html`<div class="watch ok"><${Icon} name="checkCircle" size=${18} /><div>已接入：${joined.map((m, i) => html`${i ? "、" : ""}<b>${m.name}</b>${m.host ? `（${m.host}）` : ""}`)}。可点「完成」关闭本窗口。</div></div>`
		: html`<div class="watch"><span class="spin"></span><div>等待渲染机接入…安装完成后会在这里显示，同时出现在「渲染机 / GPU」列表中。</div></div>`;
}

function WindowsTab({ info, pk, since, ...rest }) {
	const ready = !!pk?.targets.windows.available;
	const [link, setLink] = useState(null);
	useEffect(() => setLink(null), [info.address]);
	const getLink = async () => {
		if (link && link.host === info.address && link.expiresAt - Date.now() > 3600e3) return link.url;
		const r = await run(() => api("POST", "/agent-setup-link", { host: info.address }));
		if (!r) return null;
		setLink({ ...r, host: info.address });
		return r.url;
	};
	const download = async () => {
		const url = await getLink();
		if (url) location.href = url;
	};
	return html`<ol class="stepper">
		<li class=${ready ? "done" : "current"}>
			<div class="stepper-t">准备安装程序</div>
			<div class="stepper-b"><${PackageStatus} name="windows" pk=${pk} accept=".exe" ...${rest} /></div>
		</li>
		<li class=${ready ? "current" : "todo"}>
			<div class="stepper-t">把安装程序下载到渲染机</div>
			<div class="stepper-d">在渲染机的浏览器中打开安装链接即可下载。安装程序已包含平台地址 <code>${info.address}</code> 与接入令牌，链接 24 小时内有效；也可以直接下载后用 U 盘或共享文件夹拷贝过去。</div>
			<div class="stepper-b">
				${!info.token
					? html`<span class="muted small">安装链接包含接入令牌，只有管理员可以生成。</span>`
					: !ready
						? html`<span class="muted small">完成第 1 步后可用。</span>`
						: html`<div class="row-btns" style="margin-top:0">
								<${CopyButton} class="primary" label="复制安装链接" value=${getLink} />
								<${AsyncButton} onClick=${download}><${Icon} name="download" size=${15} />直接下载<//>
							</div>
							${link && html`<${CopyLine} value=${link.url} /><div class="faint small">链接有效期至 ${fmt.time(link.expiresAt)}；下载时附带当前的接入令牌</div>`}`}
			</div>
		</li>
		<li class="todo">
			<div class="stepper-t">在渲染机上双击运行</div>
			<div class="stepper-d">按提示点「下一步」：确认平台地址 → 填写机器名称、选择 UE 程序所在文件夹 → 选择运行方式 → 安装。修改设置可再次运行安装程序；卸载在 Windows「设置 → 应用」中进行。</div>
			<div class="stepper-b note">支持 Windows 10 / 11（需管理员权限）。首次运行若出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」（安装程序未做代码签名）。</div>
		</li>
		<li class="todo">
			<div class="stepper-t">确认接入</div>
			<div class="stepper-b"><${JoinWatch} since=${since} /></div>
		</li>
	</ol>`;
}

function LinuxTab({ info, pk, since, params, setParams, ...rest }) {
	const ready = !!pk?.targets.linux.available;
	const c = commands(info, params);
	return html`
		<${Params} params=${params} setParams=${setParams} dirKey="linuxDir" dirHint="只允许 Agent 启动该目录下的程序（强烈建议）；留空 = 不限制" />
		<ol class="stepper">
			<li class=${ready ? "done" : "current"}>
				<div class="stepper-t">准备 Linux Agent</div>
				<div class="stepper-b"><${PackageStatus} name="linux" pk=${pk} ...${rest} /></div>
			</li>
			<li class=${ready ? "current" : "todo"}>
				<div class="stepper-t">在渲染机上执行</div>
				<div class="stepper-d">下载 Agent 并连接本平台（关闭终端即停止，开机自启见下一步）。</div>
				<div class="stepper-b"><${Cmd} code=${c.linux} /></div>
			</li>
			<li class="todo">
				<div class="stepper-t">开机自启（可选）</div>
				<div class="stepper-d">在同一目录以普通用户执行（UE 不能以 root 运行），注册为 systemd 服务：</div>
				<details class="more">
					<summary><${Icon} name="chevronDown" size=${14} />显示 systemd 命令</summary>
					<${Cmd} code=${c.systemd} />
				</details>
			</li>
			<li class="todo">
				<div class="stepper-t">确认接入</div>
				<div class="stepper-b"><${JoinWatch} since=${since} /></div>
			</li>
		</ol>`;
}

function CliTab({ info, params, setParams }) {
	const c = commands(info, params);
	return html`
		<${Params} params=${params} setParams=${setParams} dirKey="winDir" dirHint="只允许 Agent 启动该目录下的程序（强烈建议）；多个目录可在安装后修改" />
		<div class="section-t"><h4>Windows 静默安装（批量部署）</h4></div>
		<p class="muted small">先用「Windows 图形安装」中的安装链接下载安装程序（已包含平台地址与令牌），在每台渲染机的 PowerShell 中以管理员身份执行；机器名称留空时各自使用计算机名，同一条命令可用于所有机器。</p>
		<${Cmd} code=${c.windowsSilent} />
		<p class="faint small">
			其它可选参数：<code>/mode=logon</code>（登录 Windows 后运行；默认为开机自动运行的 Windows 服务）、<code>/dir=安装位置</code>。结果记录在 <code>%TEMP%\\ps-platform-agent-setup.log</code>。
		</p>
		<div class="section-t"><h4>Windows 命令行运行（不安装）</h4></div>
		<p class="muted small">在 PowerShell 中执行；关闭窗口即停止。也可用 Node.js ≥ 22 运行源码中的 <code>agent/agent.js</code>。</p>
		<${Cmd} code=${c.windowsRun} />`;
}

/** 连接信息：渲染机访问地址（可选择 / 自定义）、Agent 连接地址、接入令牌（显示 / 复制 / 轮换） */
function ConnInfo({ info, applyHost, onRotate }) {
	const [custom, setCustom] = useState(false);
	const [draft, setDraft] = useState("");
	const [show, setShow] = useState(false);
	const hosts = info.hosts?.some((h) => h.host === info.address) ? info.hosts : [{ host: info.address, label: "自定义" }, ...(info.hosts || [])];
	const commit = async () => {
		const v = draft.trim();
		if (!v || v === info.address) return setCustom(false);
		if (await applyHost(v)) setCustom(false);
	};
	const mask = info.token ? "•".repeat(16) + info.token.slice(-4) : "";
	return html`<div class="conn">
		<div class="conn-row">
			<span class="conn-l"><${Icon} name="globe" />渲染机访问地址</span>
			<div class="conn-v">
				${custom
					? html`<input
							value=${draft}
							placeholder="例如 192.168.1.10:88"
							spellcheck="false"
							autofocus
							onInput=${(e) => setDraft(e.target.value)}
							onKeyDown=${(e) => (e.key === "Enter" ? commit() : e.key === "Escape" && setCustom(false))}
						/><button class="primary sm" onClick=${commit}>应用</button><button class="ghost sm" onClick=${() => setCustom(false)}>取消</button>`
					: html`<select
							value=${info.address}
							aria-label="渲染机访问地址"
							onChange=${(e) => (e.target.value === "__custom__" ? (setDraft(info.address), setCustom(true)) : applyHost(e.target.value))}
						>
							${hosts.map((h) => html`<option value=${h.host}>${h.host}　${h.label}${h.loopback ? "（仅本机）" : ""}</option>`)}
							<option value=${"__custom__"}>自定义地址…</option>
						</select>`}
			</div>
			<div class="conn-a">${!custom && html`<${CopyButton} value=${info.address} />`}</div>
			<div class="conn-h">渲染机通过这个地址连接平台（管理口），安装程序、安装链接和下面的命令都使用它，需在渲染机上能访问。</div>
			${info.loopback && html`<${Alert} tone="warn" class="conn-warn">这是本机回环地址，其它渲染机无法通过它连接平台。请在上面选择内网地址，或选「自定义地址」填写渲染机能访问的 IP / 域名。<//>`}
		</div>
		<div class="conn-row">
			<span class="conn-l"><${Icon} name="link" />Agent 连接地址</span>
			<div class="conn-v"><code title=${info.url}>${info.url}</code></div>
			<div class="conn-a"><${CopyButton} value=${info.url} /></div>
		</div>
		<div class="conn-row">
			<span class="conn-l"><${Icon} name="key" />接入令牌</span>
			<div class="conn-v">${info.token ? html`<code class=${show ? "" : "secret"} title=${show ? info.token : "点右侧眼睛图标显示"}>${show ? info.token : mask}</code>` : html`<span class="muted small">仅管理员可见</span>`}</div>
			<div class="conn-a">
				${info.token &&
				html`<button class="icon sm" onClick=${() => setShow(!show)} title=${show ? "隐藏令牌" : "显示令牌"} aria-label=${show ? "隐藏令牌" : "显示令牌"}><${Icon} name=${show ? "eyeOff" : "eye"} /></button>
					<${CopyButton} value=${info.token} />
					<button class="ghost sm" onClick=${onRotate} title="生成新令牌，旧令牌立即失效">轮换</button>`}
			</div>
		</div>
	</div>`;
}

function InstallModal({ initial, onClose }) {
	const s = useStore();
	const [info, setInfo] = useState(initial);
	const [tab, setTab] = useState("windows");
	const [pk, setPk] = useState(null);
	const [up, setUp] = useState({});
	const [params, setParams] = useState({ id: "", winDir: "D:\\UEProject", linuxDir: "/opt/ue" });
	const since = useRef(null);
	if (!since.current) since.current = new Set((s.overview?.machines || []).filter((m) => m.online).map((m) => m.id));
	const load = (host) => api("GET", `/agent-install${host ? `?host=${encodeURIComponent(host)}` : ""}`);
	const applyHost = async (host) => {
		const r = await run(() => load(host));
		if (r) setInfo(r);
		return !!r;
	};
	const reload = async () => {
		try {
			setPk(await api("GET", "/agent-packages"));
		} catch (e) {
			toast(e.message, "bad");
		}
	};
	useEffect(() => {
		reload();
		// 在服务器本机用 127.0.0.1 / localhost 打开管理端时，改用第一个内网地址（渲染机无法使用回环地址）
		const alt = initial.loopback && initial.hosts?.find((h) => !h.loopback);
		if (alt) applyHost(alt.host);
	}, []);
	const busy = !!pk && Object.values(pk.targets).some((t) => t.job?.state === "running");
	useEffect(() => {
		if (!busy) return;
		const t = setInterval(reload, 1200);
		return () => clearInterval(t);
	}, [busy]);
	const rotate = async () => {
		if (!(await confirmDialog({ title: "轮换接入令牌", text: "轮换后旧令牌立即失效：所有渲染机上的 Agent 都需要用新令牌重新连接（Windows 渲染机重新下载安装程序运行一次即可），否则将断开且无法重连。确定轮换？", okText: "轮换" }))) return;
		if (await run(() => api("POST", "/agent-token/rotate"), "令牌已更新：之前复制的命令已失效，请重新复制；安装链接仍可使用（下载时附带新令牌）")) {
			const r = await run(() => load(info.address));
			if (r) setInfo(r);
		}
	};
	const pass = { info, pk, reload, up, setUp, since: since.current, params, setParams };
	return html`<${Modal} wide title="接入渲染机" sub="在渲染机上安装 Agent，连接平台后即可调度 UE 实例" onClose=${onClose} footer=${html`<button class="primary" onClick=${onClose}>完成</button>`}>
		<div class="section-t"><h4>连接信息</h4>${!info.token && html`<span class="faint small">接入令牌只有管理员可以查看，命令中已隐藏</span>`}</div>
		<${ConnInfo} info=${info} applyHost=${applyHost} onRotate=${rotate} />
		<div style="margin-top:18px">
			<${Tabs}
				tabs=${[
					["windows", "Windows 图形安装", null, "windows"],
					["linux", "Linux", null, "terminal"],
					["cli", "命令行 / 批量部署", null, "layers"],
				]}
				value=${tab}
				onChange=${setTab}
			/>
		</div>
		<div class="tab-body">
			${tab === "windows" && html`<${WindowsTab} ...${pass} />`}
			${tab === "linux" && html`<${LinuxTab} ...${pass} />`}
			${tab === "cli" && html`<${CliTab} ...${pass} />`}
		</div>
		<p class="faint small" style="margin:16px 0 0">平台只接受来自「UE/Agent 允许网段」且令牌正确的连接。</p>
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
				<button class="ghost sm" onClick=${() => setGpus([...gpus, { index: gpus.length, name: "", memTotalMB: 8192 }])}><${Icon} name="plus" size=${14} />添加 GPU</button>
			</div>
			<span class="field-h">无法自动检测显卡时（国产/AMD 显卡、未装 nvidia-smi）在此填写，平台按程序的估算显存分配；能自动检测时以实时数据为准</span>
		</div>
	<//>`;
}
