# ps-platform 设计说明（新一代 UE 像素流管理平台）

## 1. 目标

取代 PeerStreamEnterprise，解决其闭源、默认无鉴权、白名单可伪造、配置陷阱、Node 新版本崩溃、无法区分 UE/浏览器 ICE 等问题；在开源 peer-stream 的协议基础上，
提供"多程序 × 多机器 × 多 GPU"的实例全生命周期管理、可视化运维与零 UDP 映射的对外服务。

设计原则：
- **协议兼容**：UE 像素流插件（4.27 / 5.x / 5.5 像素流2）与浏览器 `peer-stream.js` 无需改动即可接入；旧版 `exec-ue` 仍可用。
- **默认安全**：管理端必须登录（scrypt 口令 + JWT + 角色），公网入口只承载观众流量，UE/Agent 只能内网接入且需令牌。
- **确定性调度**：平台生成实例 ID 并写入 UE 启动参数，UE 连接即可精确绑定实例，不再依赖端口号/进程扫描猜测。
- **事件驱动**：Agent 主动上报 GPU/进程状态，平台不轮询、不执行 netstat/taskkill 之类的猜测性命令。
- **零外部依赖**：Node.js 内置 `node:sqlite`、`crypto`；仅依赖 `ws`；管理端前端无需构建工具。

## 2. 组件

```
            ┌──────────── 公网（只开放 nginx 一个 TCP 端口）────────────┐
 浏览器 ─▶ nginx 443 ─┬─ https/wss ─▶ ps-platform 玩家口(8088)：播放页 + 观众信令
                     └─ TURN/TCP/TLS ─▶ TURN 子进程（turn-tcp，多 worker）─UDP─▶ UE
            └──────────────────────────────────────────────────────────┘
 内网：
   管理员浏览器 ─▶ ps-platform 管理口(88)：/admin 管理端、/api/v1、/metrics
   UE ──────────▶ ws://网关:88/ue/<程序>/<实例ID>
   ps-agent ────▶ ws://网关:88/agent?token=…（每台渲染机一个，负责拉起/停止 UE、上报 GPU）
```

| 模块 | 职责 |
|---|---|
| `src/config.js` | 读取 `config.json` + 环境变量，校验并提供默认值 |
| `src/store.js` | SQLite 持久化（用户、程序、机器、会话历史、分享链接、审计、设置），自动迁移 |
| `src/auth.js` | scrypt 口令、HS256 JWT、角色（admin/operator/viewer）、登录限速 |
| `src/http.js` | 轻量路由、静态文件、安全响应头、JSON 工具 |
| `src/signaling.js` | UE / 观众 / Agent 三类 WebSocket 协议处理 |
| `src/scheduler.js` | 程序实例池：排队、扩缩容、放置、预热、空闲回收、失败重试 |
| `src/agents.js` | Agent 会话、GPU/CPU 指标、启动/停止命令 |
| `src/sessions.js` | 观众会话、QoS 上报、历史落库 |
| `src/api.js` | REST API 与实时事件推送 |
| `src/metrics.js` | Prometheus 指标、时间序列（仪表盘曲线） |
| `lib/turn-tcp.js` | TURN/TCP 中继（与 peer-stream 共用） |
| `agent/agent.js` | 渲染节点代理（单文件，零依赖之外只需 ws） |
| `admin/` | 管理端（Preact + htm，ES Module，无需构建） |
| `public/` | 播放页与浏览器 SDK |

## 3. 数据模型

| 表 | 字段（要点） |
|---|---|
| `users` | id, username, password_hash, role, disabled, created_at, last_login_at |
| `programs` | id(=URL 前缀), name, exe, args, cwd, ue_version, mode(shared/exclusive), max_viewers, min_instances, max_instances, idle_release_sec, startup_timeout_sec, res_x, res_y, fps, gpu_mem_mb, machines(json), require_token, enabled |
| `machines` | id, name, host, enabled, max_instances, tags, last_seen_at, info(json) |
| `sessions` | id, program_id, instance_id, client_ip, external, user_agent, started_at, ended_at, end_reason, avg_kbps, avg_rtt_ms, transport |
| `share_links` | id, program_id, note, expires_at, max_uses, uses, revoked, created_by |
| `audit` | id, ts, username, ip, action, target, detail |
| `settings` | key, value(json) |

运行时状态（内存）：实例、观众、Agent 连接、排队队列、指标环形缓冲。

## 4. 实例状态机

```
           start 命令              UE 连接+就绪            有观众
 (none) ──────────▶ starting ───────────────▶ ready ◀──────────▶ busy
                      │ 超时/启动失败          │  无观众           │
                      ▼                        ▼                  │ UE 断开
                    failed ──重试(换卡/换机)── idle ──超时──▶ stopping ──▶ (none)
```

- **starting**：已下发启动命令，等待 UE 以 `/ue/<程序>/<实例ID>` 连接；超过 `startup_timeout_sec` 判定失败，停止进程并换 GPU/机器重试（最多 3 次）。
- **ready/busy/idle**：就绪后按程序模式分配观众：`exclusive` 一实例一观众；`shared` 每实例最多 `max_viewers`。
- **回收**：无观众超过 `idle_release_sec` 且实例数 > `min_instances` 时停止；`min_instances` 即预热数量。
- **UE 意外断开**：该实例观众重新排到队首，立即补足实例。
- **手动/旧版 UE**（不带实例 ID 连接）：作为"手动实例"加入对应程序（路径首段即程序 ID，否则默认程序），不参与回收。

## 5. 调度与放置

1. 观众进入：校验程序/令牌 → 有空位的实例中选负载最低者 → 否则排队并扩容。
2. 扩容需求 = 排队人数折算的实例数 + 预热数 − (就绪空位 + 启动中)；受 `max_instances` 限制。
3. 放置：候选 = 在线且启用的 Agent ∩ 程序允许的机器；按 GPU **可用显存 − 已预留** 选最大者（需 ≥ `gpu_mem_mb`），其次实例数最少、GPU 利用率最低；下发后预留显存直至 Agent 下次上报。
4. UE 启动参数由平台生成：`-PixelStreamingURL=ws://<网关>:<端口>/ue/<程序>/<实例ID> -graphicsadapter=<GPU> -ForceRes -ResX -ResY -PixelStreamingWebRTCFps -RenderOffScreen -Unattended` + 程序自定义参数。
5. Agent 以参数数组 `spawn`（不经过 shell，杜绝命令注入），按 PID 结束进程树。

## 6. 协议

**观众（子协议 `peer-stream`，与原版兼容）**：`seticeServers`、`playerConnected`、`offer/answer/iceCandidate`、`playerqueue`、`ueDisConnected`、`ping/pong`；新增观众→平台 `stats`（码率/帧率/RTT/链路，每 5 秒）。

**UE**：与原版一致（`identify`、`config`、`endpointId`、`playerConnected`、`playerDisconnected`…）。

**Agent（子协议 `ps-agent`）**：
- Agent→平台：`hello{machineId,hostname,platform,version,gpus[],cpus,memTotalMB}`、`stats{cpu,memUsedMB,gpus[],procs[]}`（5 秒）、`started{instanceId,pid}`、`exited{instanceId,code}`、`error{instanceId,message}`
- 平台→Agent：`start{instanceId,exe,args[],cwd}`、`stop{instanceId}`
- 旧版 `exec-ue` 子协议：平台下发拼好的命令字符串（兼容）。

## 7. 安全

- 管理端：登录（scrypt N=16384）、JWT（HS256，8 小时，httpOnly + SameSite=Strict Cookie）、角色：`admin`（全部）/`operator`（实例、程序、会话）/`viewer`（只读）；连续失败 5 次锁定 IP 5 分钟；所有写操作记审计。
- 写操作要求 JSON 请求体 + `X-PS-Request: 1` 头（防 CSRF）。
- 观众入口（玩家口）只提供播放页、SDK、观众信令与公开程序列表；可要求令牌（分享链接 JWT，含程序、有效期、次数）。
- UE/Agent：仅 `engineAllow` 网段；Agent 需 `agentToken`；经代理来的请求一律拒绝。
- Agent 端 `allowExe` 前缀白名单。

## 8. 性能

- 所有路由与分配为 O(1)/O(实例数) 的内存操作；状态变化通过事件总线合并推送（每秒最多 1 次）。
- SQLite WAL 模式，会话历史批量写入。
- TURN 中继在独立子进程（多 worker）中，与信令/管理隔离。
- 时间序列：最近 24 小时每分钟、最近 1 小时每 10 秒的环形缓冲，内存固定。
