# ps-platform API 与二次开发

## 1. 认证

| 方式 | 用法 | 适用 |
|---|---|---|
| 会话 Cookie | `POST /api/v1/auth/login` 后浏览器自动携带 `ps_session`；写操作必须带请求头 `X-PS-Request: 1`（CSRF 防护） | 管理端 |
| API 令牌 | 管理端「系统设置 → API 令牌」创建（明文只显示一次），请求头 `Authorization: Bearer psk_xxx` | 业务系统对接 |

- 管理接口只在**管理口**（默认 88）提供，且来源 IP 须在 `security.adminAllow` 内；观众口只开放 `public/programs` 等观众接口。
- 角色：`viewer`（只读）< `operator`（程序/实例/机器/会话/访问链接）< `admin`（全部）。API 令牌按创建时选择的角色授权，且不能调用账户安全接口（改口令、两步验证、用户管理、令牌管理、设置修改）。
- 跨域调用：「系统设置 → 安全 → CORS 来源」添加业务系统的来源（如 `https://app.example.com`）。
- 限流：每 IP 默认 20 次/秒（突发 60），超出返回 429。错误统一返回 `{ "error": "说明" }`。

```bash
TOKEN=psk_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx
curl -H "Authorization: Bearer $TOKEN" http://192.168.1.10:88/api/v1/overview
```

## 2. 接口一览（前缀 `/api/v1`）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | 公开 | `{username,password,code?}`；开启两步验证时先返回 401 `{totpRequired:true}` |
| POST | `/auth/logout` · `/auth/logout-all` | viewer | 退出 / 让本人所有设备登录失效 |
| GET | `/auth/me` | viewer | 当前用户、版本、对外访问地址 publicBaseUrl |
| POST | `/auth/password` | viewer | `{oldPassword,newPassword}` |
| POST | `/auth/totp/setup` · `/auth/totp/enable` · `/auth/totp/disable` | viewer | 两步验证 |
| GET | `/overview` | viewer | 概览：KPI、程序、实例、机器、观众（实时推送：WebSocket `/api/v1/events`） |
| GET | `/stats/series?range=1h\|24h` | viewer | 时间序列 |
| GET/POST | `/programs` | viewer / operator | 程序列表 / 新建 |
| GET/PUT/DELETE | `/programs/:id` | viewer / operator / admin | 程序详情 / 修改 / 删除 |
| GET/POST | `/instances` | viewer / operator | 实例列表 / 手动启动 `{programId, machineId?}` |
| POST | `/instances/:id/stop` · `/instances/:id/drain` | operator | 停止 / 排空 |
| GET | `/machines` | viewer | 机器与 GPU |
| PUT/DELETE | `/machines/:id` | operator / admin | `{name,enabled,max_instances,tags,gpus_override}` / 删除离线机器 |
| GET | `/agent-install` | operator | Agent 接入信息与命令（令牌仅管理员可见）：`downloads`、`windows` / `linux`（运行命令）、`windowsDownload` / `linuxDownload`（下载命令）、`windowsSilent`（静默安装） |
| POST | `/agent-setup-link` | admin（不可用 API 令牌） | 生成 Windows 安装链接 `{url, expiresAt, available}`，24 小时有效；下载的安装程序附带平台地址与当前接入令牌 |
| GET | `/agent-packages` | operator | Agent 安装包状态：`targets.windows`（图形安装程序）/ `targets.linux`（Agent 程序）的来源、版本、大小、SHA256、获取任务进度 |
| PUT | `/agent-packages/:target` | admin | 上传安装包（请求体为文件原始内容，`Content-Type: application/octet-stream`，上限 512MB）；校验文件类型，Windows 必须是含 Agent 的安装程序 |
| POST | `/agent-packages/:target/fetch` | admin | 后台从发布页获取（`downloads.releaseBaseUrl`），进度见 `/agent-packages` |
| DELETE | `/agent-packages/:target` | admin | 删除上传 / 获取的安装包 |
| POST | `/agent-token/rotate` | admin | 轮换 Agent 令牌 |
| GET | `/sessions/live` | viewer | 在线观众（含 QoS） |
| POST | `/sessions/:id/kick` | operator | 踢出观众 |
| GET | `/sessions/history?program=&from=&to=&ip=&limit=&offset=` | viewer | 会话历史 |
| GET | `/sessions/export?program=&from=&to=&ip=` | viewer | 导出会话 CSV（UTF-8 BOM，Excel 可直接打开，最多 10 万条） |
| GET | `/sessions/stats?days=7` | viewer | 按程序统计会话数与时长 |
| GET/POST | `/share-links` | viewer / operator | 访问链接 `{programId,hours,maxUses,note}`，返回 `path` |
| POST | `/share-links/:id/url` | operator | 重新获取已有链接的地址（令牌按原有效期重新签发） |
| POST | `/share-links/:id/revoke` | operator | 作废 |
| GET/POST/PUT/DELETE | `/users`、`/users/:id`、`/users/:id/logout` | admin | 用户管理 |
| GET/POST/DELETE | `/api-tokens`、`/api-tokens/:id` | admin | API 令牌 |
| GET/PUT | `/settings` | admin | 运行期设置（密钥显示为 `******`，回传表示不修改） |
| POST | `/alerts/test` | admin | 告警测试 |
| GET | `/logs?level=&q=&after=&limit=` | admin | 运行日志 |
| GET / POST | `/backup` / `/restore` | admin | 备份导出 / 恢复（原子） |
| GET | `/audit?limit=&offset=&q=` | admin | 审计日志（q 按用户 / 操作 / 对象 / IP 搜索） |
| GET | `/system` | viewer | 版本、端口、资源 |
| GET | `/public/programs` | 公开（观众口可用） | 门户页程序列表 |
| POST | `/tools/pathfinder`（兼容 `/api/pathfinder`） | viewer 或公开* | 寻路（企业版格式） |
| POST | `/tools/coordinate`（兼容 `/api/coordinatecovert`） | viewer 或公开* | 坐标转换（企业版格式） |

\* 「系统设置 → 安全 → 工具接口公开」开启后免登录，且观众口也可调用。

其它：`GET /healthz`（健康检查）、`GET /metrics`（Prometheus，仅 `adminAllow` 网段）。

渲染机使用（仅管理口，来自 `adminAllow` 或 `engineAllow` 网段，无需登录）：

| 路径 | 说明 |
|---|---|
| `GET /download/agent/windows-setup?k=<安装链接令牌>` | Windows 图形安装程序，末尾附带平台地址与接入令牌（链接由 `/agent-setup-link` 生成） |
| `GET /download/agent/windows` | Windows 图形安装程序（不含配置，向导中手动填写地址与令牌） |
| `GET /download/agent/windows-exe` | Windows Agent 程序本身（命令行方式使用） |
| `GET /download/agent/linux` | Linux Agent 程序 |
| `GET /agent/check`（请求头 `X-Agent-Token`） | 安装向导检测连接：令牌正确返回 `{ok:true, version}`，否则 401（限速） |

## 3. 程序字段

| 字段 | 说明 |
|---|---|
| `id` | 小写字母/数字/`-`/`_`，1-32 位；播放地址 `/play/<id>` |
| `name` `description` | 显示名称、描述 |
| `exe` `args` `cwd` | 渲染机上的可执行文件、额外参数、工作目录；`exe_overrides: {机器ID: 路径}` 各机器不同路径 |
| `ue_version` | `auto` / `4.27` / `5` / `5.52`（UE5.5 像素流 2） |
| `mode` `max_viewers` | `exclusive`（一人一实例）/ `shared`（多人同看，单实例上限） |
| `prewarm` `prewarm_hours` | 预热空闲实例数、预热时段（如 `8-20`） |
| `max_instances` `idle_release_sec` `startup_timeout_sec` | 实例上限、空闲释放、启动超时 |
| `res_x` `res_y` `fps` `max_bitrate_mbps` `min_bitrate_mbps` `audio` | 画面参数 |
| `gpu_mem_mb` `machines` | 估算显存（放置用）、允许的机器 |
| `require_token` `public` `enabled` | 需要访问链接、出现在门户、启用 |
| `allow_ips` `one_session_per_ip` `inactive_release_sec` `hide_cursor` | 观众 IP 白名单、同 IP 单会话、无操作断开、隐藏鼠标 |
| `allow_commands` | 允许观众执行 UE 控制台命令（默认 false，有安全风险） |

示例：

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" http://192.168.1.10:88/api/v1/programs \
  -d '{"id":"factory","name":"智慧工厂","exe":"D:\\UE\\Factory\\Factory.exe","mode":"exclusive","prewarm":1,"max_instances":8,"gpu_mem_mb":3000}'
# 生成 24 小时有效、最多 50 人使用的访问链接
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" http://192.168.1.10:88/api/v1/share-links \
  -d '{"programId":"factory","hours":24,"maxUses":50,"note":"客户演示"}'
```

## 4. 播放页嵌入与 SDK

- 直接嵌入：`<iframe src="http(s)://<网关:端口>/video.html?urlPrefix=<程序ID>[&token=...]" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>`（与企业版地址一致；也可用 `/play/<程序ID>`）。http/https 的选择与证书要求见 INSTALL.md 第 7 节
- 自己的页面：引入 `https://<网关>/peer-stream.js`，`<video is="peer-stream" id="ps"></video>`，信令地址 `wss://<网关>/play/<程序ID>`；与原 peer-stream SDK 兼容（`emitMessage`、`addEventListener("message", …)` 等）。
- 自定义网页托管：把页面放进 `data/www/`，观众口直接访问；`data/www/index.html` 会替代默认门户页。

## 5. 观众连接关闭码

| 码 | 含义 |
|---|---|
| 4000 | 程序不存在或已停用 |
| 4001 | 被管理员踢出 |
| 4002 | 长时间无操作自动断开 |
| 4003 | 需要有效的访问链接（缺失/过期/作废/次数用完） |
| 4004 | 未找到对应程序 |
| 4005 | 同一 IP 打开了新的会话 |
| 4006 | 来源 IP 不在白名单 |
| 1008 | 信令消息洪泛 |
