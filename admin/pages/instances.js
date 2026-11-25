import { html, useStore, api, run, Card, Table, StateBadge, Badge, Modal, Field, fmt, can, useState, confirmDialog } from "../lib.js";

export function Instances() {
	const s = useStore();
	const [starting, setStarting] = useState(false);
	const o = s.overview;
	if (!o) return html`<div class="boot">加载中…</div>`;
	const programs = o.programs || [];
	const stop = (i) => confirmDialog(`确定停止实例 ${i.id}？其观众会被重新分配到其它实例。`) && run(() => api("POST", `/instances/${i.id}/stop`), "已发送停止命令");
	const drain = (i) => run(() => api("POST", `/instances/${i.id}/drain`), "已设置排空：现有观众离开后自动停止");
	const rows = [...(o.instances || [])].sort((a, b) => a.programId.localeCompare(b.programId) || a.createdAt - b.createdAt);
	return html`
		<${Card}
			title=${`实例（${rows.length}）`}
			extra=${can("operator") && html`<button class="primary" onClick=${() => setStarting(true)}>启动实例</button>`}
		>
			<${Table}
				rows=${rows}
				empty="当前没有运行中的实例。观众进入时平台会按需自动启动，也可以手动启动或配置预热。"
				columns=${[
					{ title: "实例", render: (i) => html`<code>${i.id}</code>${!i.managed ? html` <${Badge}>手动<//>` : ""}${i.draining && i.state !== "stopping" ? html` <${Badge} tone="warn">排空中<//>` : ""}` },
					{ title: "程序", render: (i) => programs.find((p) => p.id === i.programId)?.name || i.programId },
					{ title: "状态", render: (i) => html`<${StateBadge} state=${i.state} />${i.attempt > 1 ? html`<div class="muted small">第 ${i.attempt} 次尝试</div>` : ""}` },
					{ title: "观众", key: "viewers" },
					{ title: "机器 / GPU", render: (i) => (i.managed ? html`${i.machineId}<span class="muted"> · GPU ${i.gpu ?? "-"}</span>` : html`<span class="muted">${i.ueIp || "手动启动"}</span>`) },
					{ title: "像素流", render: (i) => (i.ueVersion === "5.52" ? "PS2 (5.5+)" : i.ueVersion === "4.27" ? "UE4.27" : i.ueReady ? "PS1" : "-") },
					{ title: "PID", render: (i) => i.pid || "-" },
					{ title: "运行时长", render: (i) => fmt.since(i.createdAt) },
					{ title: "空闲", render: (i) => (i.state === "idle" && i.idleSince ? fmt.since(i.idleSince) : "-") },
					{
						title: "",
						class: "actions",
						render: (i) =>
							can("operator") &&
							i.state !== "stopping" &&
							html`${!i.draining && html`<button class="ghost sm" onClick=${() => drain(i)} title="不再接新观众，现有观众离开后停止">排空</button>`}
								<button class="danger sm" onClick=${() => stop(i)}>停止</button>`,
					},
				]}
			/>
		<//>
		${starting && html`<${StartModal} programs=${programs} machines=${o.machines || []} onClose=${() => setStarting(false)} />`}
	`;
}

function StartModal({ programs, machines, onClose }) {
	const [programId, setProgram] = useState(programs.find((p) => p.enabled)?.id || "");
	const [machineId, setMachine] = useState("");
	const submit = async () => {
		const r = await run(() => api("POST", "/instances", { programId, machineId: machineId || undefined }));
		if (r) {
			onClose();
			run(async () => r, `已在 ${r.machineId} 的 GPU ${r.gpu ?? 0} 上启动`);
		}
	};
	return html`<${Modal}
		title="手动启动实例"
		onClose=${onClose}
		footer=${html`<button class="ghost" onClick=${onClose}>取消</button><button class="primary" disabled=${!programId} onClick=${submit}>启动</button>`}
	>
		<${Field} label="程序" hint="只能启动配置了可执行文件路径的程序">
			<select value=${programId} onChange=${(e) => setProgram(e.target.value)}>
				${programs.filter((p) => p.enabled).map((p) => html`<option value=${p.id}>${p.name}（${p.id}）</option>`)}
			</select>
		<//>
		<${Field} label="机器" hint="留空则自动选择空闲显存最多的 GPU">
			<select value=${machineId} onChange=${(e) => setMachine(e.target.value)}>
				<option value="">自动选择</option>
				${machines.filter((m) => m.online && m.enabled).map((m) => html`<option value=${m.id}>${m.name}（${m.id}）</option>`)}
			</select>
		<//>
	<//>`;
}
