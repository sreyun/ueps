"use strict";
/**
 * REST API（/api/v1）。默认需要登录（会话 Cookie 或 Bearer API 令牌）；opts.role 指定最低角色；写操作统一记审计。
 *   opts.public     无需登录          opts.playerSafe  观众口也可访问
 *   opts.tool       工具接口（设置 publicTools 后免登录）  opts.noToken  禁止 API 令牌调用（账户安全相关）
 *   opts.rawBody    不解析 JSON，处理函数自行读取请求体（上传）
 */
const { sendJson } = require("./http.js");
const { hashPassword, verifyPasswordAsync, checkPasswordPolicy, signJwt, hasRole } = require("./auth.js");
const { totpSecret, totpVerify, otpauthUrl, newApiToken } = require("./security.js");
const { pathfind, coordinateConvert } = require("./tools.js");
const { newId } = require("./util.js");
const { PROGRAM_ID_RE } = require("./store.js");

function registerApi(router, ctx) {
	const { store, scheduler, agents, signaling, metrics, settings, secrets, config, limiter, version, alerts, log, packages } = ctx;
	const audit = (req, action, target, detail) => store.audit({ username: req.user?.username || "", ip: req.clientIp, action, target, detail });
	const httpErr = (status, message) => Object.assign(new Error(message), { status });
	const ttlSec = () => Math.round((config.security.sessionTtlHours || 8) * 3600);
	const roles = ["admin", "operator", "viewer"];
	const DUMMY_HASH = hashPassword("ps-platform-timing-guard"); // 用户不存在时也做一次口令校验，避免通过响应时间探测用户名

	const setSessionCookie = (req, res, token, maxAge) => {
		const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
		res.setHeader("Set-Cookie", `ps_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
	};
	const issueSession = (req, res, u) => setSessionCookie(req, res, signJwt({ typ: "session", sub: u.id, username: u.username, role: u.role, tv: u.token_version || 0 }, secrets.jwt, ttlSec()), ttlSec());
	/** 让该用户所有已登录会话失效（改口令、禁用、改角色、强制下线） */
	const revokeSessions = (id) => {
		const u = store.getUser(id);
		if (u) store.updateUser(id, { token_version: (u.token_version || 0) + 1 });
	};

	/* ------------------------------------------------------------- 认证 */
	router.post(
		"/api/v1/auth/login",
		async (req, res, { body }) => {
			const username = String(body.username || "").slice(0, 64);
			const userKey = `user:${username.toLowerCase()}`;
			// 按来源 IP 和用户名分别计数：同一 IP 爆破、或多 IP 轮换爆破同一账号都会被锁定
			const locked = limiter.isLocked(req.clientIp) || limiter.isLocked(userKey);
			if (locked) throw httpErr(429, `登录失败次数过多，请 ${locked} 秒后再试`);
			const u = store.getUserByName(username);
			const fail = (msg = "用户名或口令错误") => {
				limiter.fail(req.clientIp);
				limiter.fail(userKey);
				metrics.inc("loginFailures");
				store.audit({ username, ip: req.clientIp, action: "auth.login_failed" });
				if (limiter.isLocked(req.clientIp)) alerts.notify("security.login_locked", `来自 ${req.clientIp} 的登录连续失败，已锁定`, { key: req.clientIp });
				throw httpErr(401, msg);
			};
			const passOk = await verifyPasswordAsync(String(body.password || ""), u ? u.password_hash : DUMMY_HASH);
			if (!u || u.disabled || !passOk) fail();
			if (u.totp_secret) {
				if (!body.code) return sendJson(res, 401, { error: "请输入两步验证码", totpRequired: true });
				if (!totpVerify(u.totp_secret, body.code, `u${u.id}`)) fail("两步验证码错误");
			}
			limiter.success(req.clientIp);
			limiter.success(userKey);
			store.updateUser(u.id, { last_login_at: Date.now() });
			issueSession(req, res, u);
			store.audit({ username: u.username, ip: req.clientIp, action: "auth.login" });
			metrics.inc("logins");
			sendJson(res, 200, { user: { id: u.id, username: u.username, role: u.role, totp: !!u.totp_secret }, mustChangePassword: !!store.getSetting(`mustChange:${u.id}`) });
		},
		{ public: true }
	);
	router.post("/api/v1/auth/logout", async (req, res) => (setSessionCookie(req, res, "", 0), sendJson(res, 200, { ok: true })), { public: true });
	router.post(
		"/api/v1/auth/logout-all",
		async (req, res) => {
			revokeSessions(req.user.id);
			setSessionCookie(req, res, "", 0);
			audit(req, "auth.logout_all", req.user.username);
			sendJson(res, 200, { ok: true });
		},
		{ role: "viewer", noToken: true }
	);
	router.get(
		"/api/v1/auth/me",
		async (req, res) => {
			const u = req.user.token ? null : store.getUser(req.user.id);
			sendJson(res, 200, { user: { ...req.user, totp: !!u?.totp_secret }, mustChangePassword: u ? !!store.getSetting(`mustChange:${u.id}`) : false, version, publicBaseUrl: settings.get().publicBaseUrl || "" });
		},
		{ role: "viewer" }
	);
	router.post(
		"/api/v1/auth/password",
		async (req, res, { body }) => {
			const u = store.getUser(req.user.id);
			if (!(await verifyPasswordAsync(String(body.oldPassword || ""), u.password_hash))) throw httpErr(400, "原口令错误");
			const bad = checkPasswordPolicy(body.newPassword);
			if (bad) throw httpErr(400, bad);
			if (body.newPassword === body.oldPassword) throw httpErr(400, "新口令不能与原口令相同");
			store.updateUser(u.id, { password_hash: hashPassword(body.newPassword) });
			revokeSessions(u.id); // 其它设备上的登录立即失效
			issueSession(req, res, store.getUser(u.id)); // 当前会话换新
			store.setSetting(`mustChange:${u.id}`, false);
			audit(req, "auth.change_password", u.username);
			sendJson(res, 200, { ok: true });
		},
		{ role: "viewer", noToken: true }
	);
	// 两步验证（TOTP）
	router.post(
		"/api/v1/auth/totp/setup",
		async (req, res) => {
			const secret = totpSecret();
			store.setSetting(`totpPending:${req.user.id}`, { secret, at: Date.now() });
			sendJson(res, 200, { secret, otpauth: otpauthUrl(secret, req.user.username) });
		},
		{ role: "viewer", noToken: true }
	);
	router.post(
		"/api/v1/auth/totp/enable",
		async (req, res, { body }) => {
			const pending = store.getSetting(`totpPending:${req.user.id}`);
			if (!pending || Date.now() - pending.at > 10 * 60 * 1000) throw httpErr(400, "请重新生成密钥");
			if (!totpVerify(pending.secret, body.code, `u${req.user.id}`)) throw httpErr(400, "验证码错误，请确认手机时间准确");
			store.updateUser(req.user.id, { totp_secret: pending.secret });
			store.setSetting(`totpPending:${req.user.id}`, null);
			audit(req, "auth.totp_enable", req.user.username);
			sendJson(res, 200, { ok: true });
		},
		{ role: "viewer", noToken: true }
	);
	router.post(
		"/api/v1/auth/totp/disable",
		async (req, res, { body }) => {
			const u = store.getUser(req.user.id);
			if (!(await verifyPasswordAsync(String(body.password || ""), u.password_hash))) throw httpErr(400, "口令错误");
			store.updateUser(u.id, { totp_secret: null });
			audit(req, "auth.totp_disable", u.username);
			sendJson(res, 200, { ok: true });
		},
		{ role: "viewer", noToken: true }
	);

	/* ------------------------------------------------------------- 概览 */
	router.get("/api/v1/overview", async (req, res) => sendJson(res, 200, ctx.overview()), { role: "viewer" });
	router.get("/api/v1/stats/series", async (req, res, { query }) => sendJson(res, 200, { range: query.range === "24h" ? "24h" : "1h", points: metrics.series(query.range) }), { role: "viewer" });

	/* ------------------------------------------------------------- 程序 */
	router.get(
		"/api/v1/programs",
		async (req, res) => {
			const snap = new Map(scheduler.snapshot().programs.map((p) => [p.id, p]));
			sendJson(res, 200, store.listPrograms().map((p) => ({ ...p, runtime: snap.get(p.id) || null })));
		},
		{ role: "viewer" }
	);
	router.get(
		"/api/v1/programs/:id",
		async (req, res, { params }) => {
			const p = store.getProgram(params.id);
			if (!p) throw httpErr(404, "程序不存在");
			sendJson(res, 200, p);
		},
		{ role: "viewer" }
	);
	router.post(
		"/api/v1/programs",
		async (req, res, { body }) => {
			const p = store.createProgram(body);
			scheduler.loadPrograms();
			audit(req, "program.create", p.id, body);
			sendJson(res, 201, p);
		},
		{ role: "operator" }
	);
	router.put(
		"/api/v1/programs/:id",
		async (req, res, { params, body }) => {
			const p = store.updateProgram(params.id, body);
			if (!p) throw httpErr(404, "程序不存在");
			scheduler.loadPrograms();
			audit(req, "program.update", p.id, body);
			sendJson(res, 200, p);
		},
		{ role: "operator" }
	);
	router.del(
		"/api/v1/programs/:id",
		async (req, res, { params }) => {
			if (!store.deleteProgram(params.id)) throw httpErr(404, "程序不存在");
			scheduler.loadPrograms();
			audit(req, "program.delete", params.id);
			sendJson(res, 200, { ok: true });
		},
		{ role: "admin" }
	);

	/* ------------------------------------------------------------- 实例 */
	router.get("/api/v1/instances", async (req, res) => sendJson(res, 200, scheduler.snapshot().instances), { role: "viewer" });
	router.post(
		"/api/v1/instances",
		async (req, res, { body }) => {
			const inst = scheduler.startInstance(String(body.programId || "").toLowerCase(), { machineId: body.machineId || undefined });
			metrics.inc("instancesStarted");
			audit(req, "instance.start", inst.id, { programId: inst.programId, machineId: inst.machineId, gpu: inst.gpu });
			sendJson(res, 201, { id: inst.id, machineId: inst.machineId, gpu: inst.gpu });
		},
		{ role: "operator" }
	);
	router.post(
		"/api/v1/instances/:id/stop",
		async (req, res, { params }) => {
			if (!scheduler.stopInstance(params.id, `stopped by ${req.user.username}`)) throw httpErr(404, "实例不存在");
			audit(req, "instance.stop", params.id);
			sendJson(res, 200, { ok: true });
		},
		{ role: "operator" }
	);
	router.post(
		"/api/v1/instances/:id/drain",
		async (req, res, { params }) => {
			if (!scheduler.drainInstance(params.id)) throw httpErr(404, "实例不存在");
			audit(req, "instance.drain", params.id);
			sendJson(res, 200, { ok: true });
		},
		{ role: "operator" }
	);

	/* ------------------------------------------------------------- 机器 */
	router.get("/api/v1/machines", async (req, res) => sendJson(res, 200, agents.snapshot()), { role: "viewer" });
	router.put(
		"/api/v1/machines/:id",
		async (req, res, { params, body }) => {
			const m = store.updateMachine(params.id, body);
			if (!m) throw httpErr(404, "机器不存在");
			scheduler.scaleAll();
			audit(req, "machine.update", params.id, body);
			sendJson(res, 200, m);
		},
		{ role: "operator" }
	);
	router.del(
		"/api/v1/machines/:id",
		async (req, res, { params }) => {
			if (agents.get(params.id)) throw httpErr(409, "机器在线，不能删除（可先停用）");
			if (!store.deleteMachine(params.id)) throw httpErr(404, "机器不存在");
			audit(req, "machine.delete", params.id);
			sendJson(res, 200, { ok: true });
		},
		{ role: "admin" }
	);
	/** 渲染机访问平台管理口的地址：取管理员当前访问管理端所用的地址（渲染机与其同在内网） */
	const adminOrigin = (req) => {
		const host = req.headers.host || `127.0.0.1:${config.http.port}`;
		const tls = !!config.http.tls?.admin;
		return { host, http: `${tls ? "https" : "http"}://${host}`, ws: `${tls ? "wss" : "ws"}://${host}` };
	};
	const downloadUrls = (req) => {
		const o = adminOrigin(req);
		return { windows: `${o.http}/download/agent/windows`, windowsExe: `${o.http}/download/agent/windows-exe`, linux: `${o.http}/download/agent/linux` };
	};
	router.get(
		"/api/v1/agent-install",
		async (req, res) => {
			const o = adminOrigin(req);
			const isAdmin = hasRole(req.user.role, "admin") && !req.user.token;
			const tok = isAdmin ? secrets.agentToken : "<令牌（管理员可见）>";
			const dl = downloadUrls(req);
			const args = `--agent --url ${o.ws}/agent --token ${tok} --id render-01`;
			sendJson(res, 200, {
				url: `${o.ws}/agent`,
				address: o.host,
				token: isAdmin ? secrets.agentToken : null,
				downloads: dl,
				// 运行命令（在程序所在目录执行）。Windows 路径不要以 \ 结尾再加引号：\" 会被当成转义的引号
				windows: `.\\ps-platform.exe ${args} --allow-exe D:\\UEProject`,
				linux: `./ps-platform ${args} --allow-exe /opt/ue`,
				// 下载命令（PowerShell / Linux shell）：关闭进度条可让 Windows PowerShell 5.1 的下载快数十倍
				windowsDownload: `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri ${dl.windowsExe} -OutFile ps-platform.exe`,
				linuxDownload: `curl -fL -o ps-platform ${dl.linux} && chmod +x ps-platform`,
				// 批量部署：用安装链接下载的安装程序静默安装（已包含平台地址与令牌）
				windowsSilent: `Start-Process -Wait .\\ps-platform-agent-setup.exe -ArgumentList '/S','/id=render-01','/allow-exe=D:\\UEProject'`,
			});
		},
		{ role: "operator" }
	);
	// Windows 安装链接：24 小时内在渲染机浏览器中打开即可下载已包含平台地址与接入令牌的安装程序
	router.post(
		"/api/v1/agent-setup-link",
		async (req, res) => {
			const o = adminOrigin(req);
			const ttl = 24 * 3600;
			const k = signJwt({ typ: "agent-setup", ws: `${o.ws}/agent`, http: o.http, by: req.user.username }, secrets.jwt, ttl);
			audit(req, "agent.setup_link");
			sendJson(res, 200, { url: `${o.http}/download/agent/windows-setup?k=${k}`, expiresAt: Date.now() + ttl * 1000, available: !!packages.resolve("windows") });
		},
		{ role: "admin", noToken: true }
	);

	/* ------------------------------------------------------- Agent 安装包 */
	router.get(
		"/api/v1/agent-packages",
		async (req, res) => sendJson(res, 200, { ...packages.status(), downloads: downloadUrls(req) }),
		{ role: "operator" }
	);
	router.put(
		"/api/v1/agent-packages/:target",
		async (req, res, { params }) => {
			packages.target(params.target);
			const total = Number(req.headers["content-length"]) || 0;
			try {
				// 不随出错销毁请求流：保证能把错误原因返回给浏览器
				const r = await packages.save(params.target, req.iterator({ destroyOnReturn: false }), { total, origin: "upload", by: req.user.username });
				audit(req, "agent_package.upload", params.target, { size: r.size, sha256: r.sha256 });
				sendJson(res, 200, packages.status().targets[params.target]);
			} catch (e) {
				res.setHeader("Connection", "close"); // 剩余的上传数据不再读取
				throw e;
			}
		},
		{ role: "admin", rawBody: true }
	);
	router.post(
		"/api/v1/agent-packages/:target/fetch",
		async (req, res, { params }) => {
			const job = packages.startFetch(params.target, req.user.username);
			audit(req, "agent_package.fetch", params.target, { url: job.url });
			sendJson(res, 202, packages.status().targets[params.target]);
		},
		{ role: "admin" }
	);
	router.del(
		"/api/v1/agent-packages/:target",
		async (req, res, { params }) => {
			if (!packages.remove(params.target)) throw httpErr(404, "没有已上传的安装包");
			audit(req, "agent_package.delete", params.target);
			if (params.target === "windows") packages.prepare().catch(() => {}); // Windows 打包运行时改回由平台自身在后台生成
			sendJson(res, 200, packages.status().targets[params.target]);
		},
		{ role: "admin" }
	);
	router.post(
		"/api/v1/agent-token/rotate",
		async (req, res) => {
			const token = secrets.rotateAgentToken();
			audit(req, "agent.rotate_token");
			sendJson(res, 200, { token });
		},
		{ role: "admin", noToken: true }
	);

	/* ------------------------------------------------------------- 会话 */
	router.get("/api/v1/sessions/live", async (req, res) => sendJson(res, 200, signaling.livePlayers()), { role: "viewer" });
	router.post(
		"/api/v1/sessions/:id/kick",
		async (req, res, { params }) => {
			if (!signaling.kick(params.id)) throw httpErr(404, "观众不存在");
			audit(req, "session.kick", params.id);
			sendJson(res, 200, { ok: true });
		},
		{ role: "operator" }
	);
	router.get("/api/v1/sessions/history", async (req, res, { query }) => sendJson(res, 200, store.querySessions(query)), { role: "viewer" });
	// 导出 CSV（Excel 直接打开：UTF-8 BOM + CRLF），最多 10 万行
	router.get(
		"/api/v1/sessions/export",
		async (req, res, { query }) => {
			const rows = store.exportSessions(query);
			const cols = [
				["开始时间", (r) => new Date(r.started_at).toLocaleString("zh-CN", { hour12: false })],
				["结束时间", (r) => (r.ended_at ? new Date(r.ended_at).toLocaleString("zh-CN", { hour12: false }) : "")],
				["时长(秒)", (r) => (r.ended_at ? Math.round((r.ended_at - r.started_at) / 1000) : "")],
				["程序", (r) => r.program_id],
				["观众 IP", (r) => r.client_ip],
				["外网", (r) => (r.external ? "是" : "否")],
				["实例", (r) => r.instance_id || ""],
				["机器", (r) => r.machine_id || ""],
				["链路", (r) => r.transport || ""],
				["平均码率(kbps)", (r) => r.avg_kbps ?? ""],
				["平均延迟(ms)", (r) => r.avg_rtt_ms ?? ""],
				["平均帧率", (r) => r.avg_fps ?? ""],
				["结束原因", (r) => r.end_reason || ""],
				["访问链接", (r) => r.share_link_id || ""],
				["浏览器", (r) => r.user_agent || ""],
			];
			const cell = (v) => {
				let s = String(v ?? "");
				if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防 CSV 公式注入（Excel 会执行以 = + - @ 开头的单元格）
				return /[",\r\n]/.test(s) || s.startsWith("'") ? '"' + s.replace(/"/g, '""') + '"' : s;
			};
			const NL = String.fromCharCode(13, 10);
			const body = String.fromCharCode(0xfeff) + [cols.map((c) => c[0]).join(","), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(","))].join(NL) + NL;
			audit(req, "session.export", query.program || "", { rows: rows.length });
			res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="sessions-${new Date().toISOString().slice(0, 10)}.csv"` });
			res.end(body);
		},
		{ role: "viewer" }
	);
	router.get(
		"/api/v1/sessions/stats",
		async (req, res, { query }) => {
			const days = Math.min(90, Math.max(1, +query.days || 7));
			sendJson(res, 200, { days, programs: store.sessionStats(Date.now() - days * 86400000) });
		},
		{ role: "viewer" }
	);

	/* ------------------------------------------------------------- 分享链接 */
	router.get("/api/v1/share-links", async (req, res) => sendJson(res, 200, store.listShareLinks()), { role: "viewer" });
	router.post(
		"/api/v1/share-links",
		async (req, res, { body }) => {
			const pid = String(body.programId || "").toLowerCase();
			if (!PROGRAM_ID_RE.test(pid) || !store.getProgram(pid)) throw httpErr(400, "程序不存在");
			const hours = Math.max(0, +body.hours || 0);
			const id = newId(12);
			const expiresAt = hours ? Date.now() + hours * 3600000 : null;
			const link = store.createShareLink({ id, program_id: pid, note: String(body.note || "").slice(0, 200), expires_at: expiresAt, max_uses: Math.max(0, +body.maxUses || 0), created_by: req.user.username });
			const token = signJwt({ typ: "share", pid, lid: id }, secrets.jwt, hours ? hours * 3600 : 0);
			audit(req, "share.create", id, { programId: pid, hours, maxUses: link.max_uses });
			sendJson(res, 201, { ...link, path: `/play/${encodeURIComponent(pid)}?token=${token}` });
		},
		{ role: "operator" }
	);
	// 重新获取已有链接的地址（令牌按原有效期重新签发；原链接仍然有效），避免"只显示一次"导致丢失后只能重建
	router.post(
		"/api/v1/share-links/:id/url",
		async (req, res, { params }) => {
			const link = store.getShareLink(params.id);
			if (!link) throw httpErr(404, "链接不存在");
			if (link.revoked) throw httpErr(409, "链接已作废");
			const left = link.expires_at ? Math.floor((link.expires_at - Date.now()) / 1000) : 0;
			if (link.expires_at && left <= 0) throw httpErr(409, "链接已过期");
			const token = signJwt({ typ: "share", pid: link.program_id, lid: link.id }, secrets.jwt, left > 0 ? left : 0);
			sendJson(res, 200, { path: `/play/${encodeURIComponent(link.program_id)}?token=${token}` });
		},
		{ role: "operator" }
	);
	router.post(
		"/api/v1/share-links/:id/revoke",
		async (req, res, { params }) => {
			if (!store.revokeShareLink(params.id)) throw httpErr(404, "链接不存在");
			audit(req, "share.revoke", params.id);
			sendJson(res, 200, { ok: true });
		},
		{ role: "operator" }
	);

	/* ------------------------------------------------------------- 用户 */
	router.get("/api/v1/users", async (req, res) => sendJson(res, 200, store.listUsers()), { role: "admin" });
	router.post(
		"/api/v1/users",
		async (req, res, { body }) => {
			const username = String(body.username || "").trim();
			if (!/^[\w.@-]{2,32}$/.test(username)) throw httpErr(400, "用户名为 2-32 位字母、数字或 _ . @ -");
			if (!roles.includes(body.role)) throw httpErr(400, "角色取值：admin / operator / viewer");
			const bad = checkPasswordPolicy(body.password);
			if (bad) throw httpErr(400, bad);
			if (store.getUserByName(username)) throw httpErr(409, "用户名已存在");
			const u = store.createUser({ username, password_hash: hashPassword(body.password), role: body.role });
			audit(req, "user.create", username, { role: body.role });
			sendJson(res, 201, { id: u.id, username: u.username, role: u.role });
		},
		{ role: "admin", noToken: true }
	);
	const lastAdminGuard = (u, fields) => {
		const demoting = (fields.role && fields.role !== "admin") || fields.disabled;
		if (u.role === "admin" && demoting && store.listUsers().filter((x) => x.role === "admin" && !x.disabled).length <= 1) throw httpErr(409, "至少保留一个可用的管理员");
	};
	router.put(
		"/api/v1/users/:id",
		async (req, res, { params, body }) => {
			const id = +params.id;
			const u = store.getUser(id);
			if (!u) throw httpErr(404, "用户不存在");
			const fields = {};
			if (body.role !== undefined) {
				if (!roles.includes(body.role)) throw httpErr(400, "角色取值：admin / operator / viewer");
				fields.role = body.role;
			}
			if (body.disabled !== undefined) fields.disabled = !!body.disabled;
			if (body.password) {
				const bad = checkPasswordPolicy(body.password);
				if (bad) throw httpErr(400, bad);
				fields.password_hash = hashPassword(body.password);
			}
			if (body.resetTotp) fields.totp_secret = null;
			lastAdminGuard(u, fields);
			const next = store.updateUser(id, fields);
			if (fields.role || fields.disabled || fields.password_hash) revokeSessions(id); // 权限变化立即生效
			audit(req, "user.update", u.username, { role: fields.role, disabled: fields.disabled, password: !!body.password, resetTotp: !!body.resetTotp });
			sendJson(res, 200, { id: next.id, username: next.username, role: next.role, disabled: next.disabled });
		},
		{ role: "admin", noToken: true }
	);
	router.post(
		"/api/v1/users/:id/logout",
		async (req, res, { params }) => {
			const u = store.getUser(+params.id);
			if (!u) throw httpErr(404, "用户不存在");
			revokeSessions(u.id);
			audit(req, "user.force_logout", u.username);
			sendJson(res, 200, { ok: true });
		},
		{ role: "admin", noToken: true }
	);
	router.del(
		"/api/v1/users/:id",
		async (req, res, { params }) => {
			const id = +params.id;
			const u = store.getUser(id);
			if (!u) throw httpErr(404, "用户不存在");
			if (id === req.user.id) throw httpErr(409, "不能删除当前登录的用户");
			lastAdminGuard(u, { disabled: true });
			store.deleteUser(id);
			audit(req, "user.delete", u.username);
			sendJson(res, 200, { ok: true });
		},
		{ role: "admin", noToken: true }
	);

	/* ------------------------------------------------------------- API 令牌（二次开发） */
	router.get("/api/v1/api-tokens", async (req, res) => sendJson(res, 200, store.listApiTokens()), { role: "admin", noToken: true });
	router.post(
		"/api/v1/api-tokens",
		async (req, res, { body }) => {
			const name = String(body.name || "").trim().slice(0, 64);
			if (!name) throw httpErr(400, "请填写令牌名称（用途）");
			if (!roles.includes(body.role)) throw httpErr(400, "角色取值：admin / operator / viewer");
			const days = Math.max(0, +body.days || 0);
			const t = newApiToken();
			store.createApiToken({ id: t.id, name, token_hash: t.hash, role: body.role, created_by: req.user.username, expires_at: days ? Date.now() + days * 86400000 : null });
			audit(req, "api_token.create", name, { role: body.role, days });
			sendJson(res, 201, { id: t.id, name, role: body.role, token: t.token }); // 明文只返回这一次
		},
		{ role: "admin", noToken: true }
	);
	router.del(
		"/api/v1/api-tokens/:id",
		async (req, res, { params }) => {
			if (!store.revokeApiToken(params.id)) throw httpErr(404, "令牌不存在");
			audit(req, "api_token.revoke", params.id);
			sendJson(res, 200, { ok: true });
		},
		{ role: "admin", noToken: true }
	);

	/* ------------------------------------------------------------- 设置 / 日志 / 备份 / 审计 / 系统 */
	router.get("/api/v1/settings", async (req, res) => sendJson(res, 200, settings.view()), { role: "admin" });
	router.put(
		"/api/v1/settings",
		async (req, res, { body }) => {
			const v = settings.update(body);
			audit(req, "settings.update", "runtime", { keys: Object.keys(body) });
			sendJson(res, 200, v);
		},
		{ role: "admin", noToken: true }
	);
	router.post(
		"/api/v1/alerts/test",
		async (req, res) => {
			const cfg = settings.get().alerts || {};
			if (!cfg.webhook) throw httpErr(400, "请先填写并保存 Webhook 地址");
			try {
				await alerts.post(cfg.webhook, cfg.format === "feishu" ? { msg_type: "text", content: { text: "【云渲染管理平台】告警测试消息" } } : cfg.format === "generic" ? { event: "test", title: "告警测试", text: "这是一条测试消息", time: Date.now() } : { msgtype: "text", text: { content: "【云渲染管理平台】告警测试消息" } });
			} catch (e) {
				throw httpErr(502, `推送失败：${e.message}`);
			}
			sendJson(res, 200, { ok: true });
		},
		{ role: "admin" }
	);
	router.get("/api/v1/logs", async (req, res, { query }) => sendJson(res, 200, log.recent ? log.recent({ level: query.level, q: query.q, after: +query.after || 0, limit: Math.min(2000, +query.limit || 500) }) : []), { role: "admin" });
	router.get(
		"/api/v1/backup",
		async (req, res) => {
			const machines = store.listMachines().map(({ id, name, enabled, max_instances, tags, gpus_override }) => ({ id, name, enabled, max_instances, tags, gpus_override }));
			const programs = store.listPrograms().map(({ created_at, updated_at, ...p }) => p);
			audit(req, "backup.export");
			sendJson(res, 200, { kind: "ps-platform-backup", version, exportedAt: Date.now(), programs, machines, settings: settings.view() }, { "Content-Disposition": `attachment; filename="ps-platform-backup-${new Date().toISOString().slice(0, 10)}.json"` });
		},
		{ role: "admin" }
	);
	router.post(
		"/api/v1/restore",
		async (req, res, { body }) => {
			if (body?.kind !== "ps-platform-backup") throw httpErr(400, "不是有效的备份文件");
			const result = { programs: 0, machines: 0, settings: false };
			if (!Array.isArray(body.programs || []) || !Array.isArray(body.machines || [])) throw httpErr(400, "备份文件格式错误");
			// 整体在一个事务内导入：任何一项校验失败都不会留下"导入一半"的状态
			store.transaction(() => {
				for (const p of body.programs || []) {
					if (store.getProgram(p.id)) store.updateProgram(p.id, p);
					else store.createProgram(p);
					result.programs++;
				}
				for (const m of body.machines || []) {
					if (typeof m?.id !== "string" || !/^[a-z0-9_-]{1,48}$/.test(m.id)) throw httpErr(400, `机器 ID 不合法：${m?.id}`);
					if (!store.getMachine(m.id)) store.touchMachine(m.id, { host: "", name: m.name, info: {} });
					store.updateMachine(m.id, m);
					result.machines++;
				}
				if (body.settings) {
					settings.update(body.settings);
					result.settings = true;
				}
			});
			scheduler.loadPrograms();
			audit(req, "backup.restore", "", result);
			sendJson(res, 200, result);
		},
		{ role: "admin", noToken: true, bodyLimit: 8 << 20 }
	);
	router.get("/api/v1/audit", async (req, res, { query }) => sendJson(res, 200, store.listAudit(query)), { role: "admin" });
	router.get("/api/v1/system", async (req, res) => sendJson(res, 200, ctx.systemInfo()), { role: "viewer" });

	/* ------------------------------------------------------------- 工具接口（兼容企业版） */
	const tool = (fn) => async (req, res, { body }) => {
		try {
			sendJson(res, 200, fn(body));
		} catch (e) {
			// 与企业版一致：业务错误返回 200 + status=-1；参数缺失返回 400
			if (e.status === 400) return sendJson(res, 400, { error: e.message });
			sendJson(res, 200, { status: -1, message: e.message });
		}
	};
	for (const p of ["/api/v1/tools/pathfinder", "/api/pathfinder"]) router.post(p, tool(pathfind), { role: "viewer", tool: true, bodyLimit: 16 << 20 });
	for (const p of ["/api/v1/tools/coordinate", "/api/coordinatecovert"]) router.post(p, tool(coordinateConvert), { role: "viewer", tool: true, bodyLimit: 8 << 20 });

	/* ------------------------------------------------------------- 公开接口 */
	router.get(
		"/api/v1/public/programs",
		async (req, res) =>
			sendJson(
				res,
				200,
				store
					.listPrograms()
					.filter((p) => p.enabled && p.public)
					.map((p) => ({ id: p.id, name: p.name, description: p.description, requireToken: p.require_token }))
			),
		{ public: true, playerSafe: true }
	);
}

module.exports = { registerApi };
