# ps-platform —— UE 像素流云渲染管理平台

一套程序完成 **信令 + 实例调度 + 管理端 + TURN 中继**，经 nginx **单个 TCP 端口**对外提供 UE 视频流：
公网 / 客户现场只需开放 nginx 的一个端口，**不需要任何 UDP 端口映射**；内网、跨网、路由器端口映射、域名访问均无需改配置。
覆盖并取代原 PeerStreamEnterprise 的全部功能。

## 特性

- **零 UDP 映射**：浏览器 ⇄ nginx（TURN over TCP/TLS，与网页同端口多路复用）⇄ 内置 TURN ⇄（内网 UDP）⇄ UE。内网观众自动直连。
- **按需调度**：独占（一人一实例）/ 共享（多人同看）；预热（可按时段）、空闲回收、排队、失败换 GPU/机器重试、排空；按 GPU 显存/利用率放置，支持手动定义 GPU。
- **稳定**：平台或 Agent 重启后自动接管仍在运行的 UE（不重复拉起、不留孤儿进程）；僵尸 UE 重连被拒；心跳检测；TURN 子进程守护。
- **安全**：管理端/UE/Agent 只在内网口；观众口与管理口分离；scrypt 口令、两步验证、会话吊销、按 IP + 用户名的登录锁定、CSRF 防护、API 令牌、访问链接、IP 白名单、限流、审计；Agent 可执行文件目录白名单、参数数组启动（无 shell 注入）。
- **好用**：Web 管理端（首次使用引导、健康横幅、概览、程序与访问〔一键复制播放地址 / 嵌入代码〕、实例、机器/GPU、观众会话与质量〔CSV 导出〕、访问链接、用户、设置、运行日志、审计〔可搜索〕；适配手机）、告警（企业微信/钉钉/飞书/Webhook）、Prometheus 指标、备份恢复、自定义网页托管、企业版兼容接口（寻路、坐标转换）。
- **性能**：1000 并发观众 p99 ≈ 300ms 拿到画面协商，平台内存约 120MB（见 docs/INSTALL.md §12）。
- **部署**：单文件可执行程序（Windows `ps-platform.exe` / Linux `ps-platform`，无需 Node.js）或 docker-compose；兼容 UE4.27 / UE5 像素流 1 / UE5.5 像素流 2。

## 快速开始

```bash
# Linux 网关（docker-compose）
cd deploy && cp .env.example .env && vi .env      # 填写 LAN_IP、UE_SUBNETS、密钥
mkdir -p certs && 放入 fullchain.pem / privkey.pem
docker compose up -d --build
# 没有 UE 时看效果：docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
```

```powershell
# Windows 单机（UE 与平台同机）
copy config.example.json config.json   # 修改 localAgent.allowExe 为 UE 所在目录
.\ps-platform.exe                       # 管理端 http://<本机IP>:88/admin/ ，初始口令见 data\initial-admin.txt
```

渲染机接入：管理端「渲染机 / GPU → 接入渲染机」复制命令，在渲染机执行（Windows）`ps-platform.exe --agent --url ws://<网关>:88/agent --token <令牌> --allow-exe "D:\UE\"` 或（Linux）`./ps-platform --agent --url ws://<网关>:88/agent --token <令牌> --allow-exe /opt/ue/`。

发布包：Windows `ps-platform-<版本>-windows-x64.zip`（内含 `ps-platform.exe`）、Linux `ps-platform-<版本>-linux-x64.tar.gz`（内含 `ps-platform`），见 GitHub Releases 或 `npm run build:exe` 自行打包。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 安装、配置、启动、验证、排障、运维、实测数据 |
| [docs/API.md](docs/API.md) | REST API、API 令牌、二次开发、播放页嵌入 |
| [docs/DESIGN.md](docs/DESIGN.md) | 架构设计 |
| [NOTICE.md](NOTICE.md) | 来源与第三方组件说明 |

## 开发

```bash
npm install            # 运行时依赖只有 ws；打包需要 esbuild（devDependency）
npm test               # 单元 + 集成测试（node:test）
npm start              # 启动（读取 config.json）
npm run build:exe      # 打包 dist/ps-platform(.exe)
node test/load/platform-load.js --admin http://127.0.0.1:88 --public ws://127.0.0.1:8088 --user admin --password <口令> --players 300   # 并发压测（模拟渲染机与观众）
```

目录：`server.js` 入口 · `src/` 平台（app、api、signaling、scheduler、agents、store、settings…）· `agent/` 渲染机代理 · `lib/turn-tcp.js` TURN 中继 · `admin/` 管理端（Preact，无需构建）· `public/` 播放页与 SDK · `deploy/` nginx / docker · `test/` 测试。
