# ps-platform 安装部署与运维手册

> 适用版本：ps-platform 1.3.0　|　运行环境：Node.js ≥ 22.13（或直接使用打包好的 `ps-platform.exe`，无需安装 Node.js）

目录

1. [架构与端口](#1-架构与端口)
2. [环境要求](#2-环境要求)
3. [方式 A：Linux 网关 + docker-compose（推荐）](#3-方式-alinux-网关--docker-compose推荐)
4. [方式 B：Windows / Linux 直接运行（可执行程序或 Node.js）](#4-方式-bwindows--linux-直接运行可执行程序或-nodejs)
5. [渲染机接入（Agent）](#5-渲染机接入agent)
6. [配置参考](#6-配置参考)
7. [访问地址与嵌入其它系统](#7-访问地址与嵌入其它系统)（含管理端使用要点）
8. [网络场景：内网 / 跨网 / 映射端口 / 自建 TURN](#8-网络场景内网--跨网--映射端口--自建-turn)
9. [部署验证清单](#9-部署验证清单)
10. [排障](#10-排障)
11. [日常运维](#11-日常运维)
12. [实测记录（测试服务器）](#12-实测记录测试服务器)
13. [构建与发布（CI / 华为云 SWR）](#13-构建与发布ci--华为云-swr)

---

## 1. 架构与端口

```
                       ┌──────────────────────────── 网关机（Linux docker-compose 或 Windows exe）────────────────────────────┐
 浏览器（内网/外网）     │                                                                                                  │
 ──TCP 443 或映射端口──▶│ nginx  stream 多路复用（唯一对外端口）                                                           │
                       │   ├─ TLS + ALPN（网页/wss）  ─▶ ps-platform 观众口 127.0.0.1:8088  （播放页、观众信令）             │
                       │   ├─ TLS 无 ALPN（TURNS）    ─▶ nginx 终止 TLS ─▶ 内置 TURN 127.0.0.1:3478                          │
                       │   └─ 明文 TCP（TURN）        ─▶ 内置 TURN 127.0.0.1:3478                                            │
                       │                                                                                                  │
 运维（仅内网）─────────▶│ ps-platform 管理口 :88  管理端 /admin、REST API、UE 信令 /ue/...、Agent 连接 /agent                │
                       └──────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                                                  │ 内网：UDP 中继（TURN ⇄ UE）、ws://网关:88（UE、Agent）
                                                   ┌──────────────┴───────────────┐
                                                   │ 渲染机：ps-platform Agent + UE │ × N
                                                   └──────────────────────────────┘
```

| 端口 | 监听地址 | 谁访问 | 说明 |
|---|---|---|---|
| 443（可改，如映射为任意外网端口） | 0.0.0.0 | 浏览器 | **唯一需要对外开放的端口**。网页（http:// 与 https:// 均可）、观众信令、TURN/TURNS 共用 |
| 80（可选） | 0.0.0.0 | 浏览器 | 跳转 https、证书签发 |
| 88 | 0.0.0.0 | 内网运维、UE、Agent | 管理端 / API / UE 信令 / Agent。**不要对公网开放** |
| 8088 | 127.0.0.1 | 只有 nginx | 观众口 |
| 3478 | 127.0.0.1 | 只有 nginx | 内置 TURN 的 TCP 监听 |
| 3480 | 127.0.0.1 | 只有内置 TURN | nginx 内部 http 入口（同端口明文 http：TURN 识别出 HTTP 请求后转到这里） |
| 49160-50159/udp | 网关内网 IP | UE 渲染机 | TURN 中继端口，**只在内网使用，无需映射** |
| 9180 | 127.0.0.1 | 健康检查 | nginx 状态口（`/healthz`） |

**为什么公网不需要 UDP**：浏览器与网关之间只走一条 TCP（TURN over TCP/TLS，经 nginx 443），网关上的 TURN 再在内网用 UDP 与 UE 互通。
内网观众在 ICE 择优时会直接连 UE（不经中继），外网观众自动走中继。

一个程序三种角色：`ps-platform`（管理平台）、`ps-platform --agent ...`（渲染机代理）、`ps-platform --turn`（TURN，由平台以子进程方式自动拉起）。

## 2. 环境要求

| 角色 | 要求 |
|---|---|
| 网关（docker） | Linux x86_64，Docker Engine ≥ 24 + compose v2，2 核 4G 起（每 600Mbps 中继约需 4 核） |
| 网关（直接运行） | Windows 10/Server 2016+ 或 Linux；`ps-platform.exe` 无依赖；或 Node.js ≥ 22.13 |
| nginx | 需 stream、stream_ssl_preread、http_v2 模块（官方 Linux 包 / Docker 镜像 / Windows zip 均内置） |
| 渲染机 | Windows（UE 打包程序）+ NVIDIA 驱动（可选，用于 GPU 感知调度）；运行 Agent |
| 浏览器 | Chrome / Edge ≥ 100，Firefox / Safari 新版 |

## 3. 方式 A：Linux 网关 + docker-compose（推荐）

### 3.1 准备

```bash
# 把 ps-platform 目录拷到网关，例如 /opt/ps-platform
cd /opt/ps-platform/deploy
cp .env.example .env
vi .env            # 至少填写 LAN_IP、UE_SUBNETS；建议填写 PS_ADMIN_PASSWORD、PS_AGENT_TOKEN、TURN_SECRET
chmod 600 .env
```

`.env` 最少内容示例：

```ini
LAN_IP=192.168.1.10                 # 网关内网 IP（UE 能访问）
UE_SUBNETS=192.168.1.0/24           # 渲染机网段
PS_ADMIN_PASSWORD=换成强口令Ab12     # 首次启动的 admin 口令（留空则随机生成到 data/initial-admin.txt）
PS_AGENT_TOKEN=$(openssl rand -hex 24 的输出)
TURN_SECRET=$(openssl rand -hex 24 的输出)
```

与其它服务共用一台机器、默认端口被占用时，改 `.env` 中的端口段（`PS_PORT`、`MUX_PORT`、`TURN_PORT`、`INT_*`、`STATUS_ADDR`、`TURN_MIN/MAX_PORT`），nginx 配置由模板自动渲染，无需手改。

### 3.2 证书

```bash
mkdir -p certs
# 正式域名：放入 fullchain.pem / privkey.pem（acme.sh / certbot 续期后平台和 nginx 会自动/重载生效）
# 临时测试（IP 访问）：自签名
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=ps-platform" \
  -keyout certs/privkey.pem -out certs/fullchain.pem
```

自签名证书下浏览器需要先点"继续访问"；此时浏览器只会使用明文 `turn:`（同样可用），`turns:` 需要受信任证书。

**证书是可选的**：`certs/` 中没有 `fullchain.pem`、`privkey.pem` 时，nginx 自动以**仅 http 模式**启动（日志 `ps-platform: 未找到 … 以仅 http 模式启动`），对外端口与 80 端口都可以 `http://` 访问播放页、嵌入地址，画面照常（明文 TURN）；只是 `https://` 暂不可用。放入证书后执行 `docker compose restart nginx` 即切换为完整模式（https / wss / turns，http:// 仍可用）。需要被 https 业务系统以 iframe 嵌入时必须配置证书（https 页面不能嵌入 http 内容）。

### 3.3 启动

```bash
docker compose up -d --build
docker compose ps                      # platform、nginx 均为 healthy
curl -s http://127.0.0.1:9180/healthz  # {"status":"ok"}
curl -s http://127.0.0.1:88/healthz    # 含版本、Agent 数、TURN 状态
```

国内网络拉镜像慢：在 `.env` 设置 `NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine`、`NGINX_IMAGE=docker.m.daocloud.io/library/nginx:stable-alpine`、`APK_MIRROR=https://mirrors.aliyun.com`。

管理端：`http://<LAN_IP>:88/admin/`（用户名 `admin`）。观众：`https://<域名或 IP[:映射端口]>/`。

首次登录后按「概览 → 开始使用」引导完成：① 系统设置 → 访问与嵌入 → 填写**对外访问地址**（观众访问 nginx 的地址，用于生成播放地址与嵌入代码；也可在 `.env` 中用 `PS_PUBLIC_BASE_URL` 预置）；② 接入渲染机；③ 新建程序；④ 在「程序与访问」点击「访问」复制播放地址 / 嵌入代码。

### 3.4 没有 UE 时先看效果（演示叠加）

```bash
# .env 中必须设置 PS_AGENT_TOKEN
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
```

会多启动一个 `demo-agent`（Agent + 无头 Chromium）。在管理端「程序 → 新建」：

| 字段 | 值 |
|---|---|
| ID | `demo` |
| 可执行文件 | `/usr/local/bin/node` |
| 启动参数 | `/app/test/e2e/fake-ue-launcher.js` |
| 模式 | 独占（或共享） |
| 预热实例 | 1 |

然后浏览器打开 `https://<网关>/play/demo`，看到 1280x720@30fps 的测试画面（帧计数在跳动）即整条链路正常。接入真实 UE 后去掉 `-f docker-compose.demo.yml` 重新 `up -d` 即可。

### 3.5 升级

```bash
cd /opt/ps-platform && 覆盖新版本文件（保留 deploy/.env、deploy/data、deploy/certs）
cd deploy && docker compose up -d --build
```

平台重启期间观众会断开并自动重连；渲染机上正在运行的 UE **不会被杀掉**，平台启动后自动接管（日志 `接管 … 仍在运行的实例`）。

### 3.6 使用预构建镜像（华为云 SWR，免本地构建）

每个发布版本都会自动构建 `linux/amd64`、`linux/arm64` 两种架构的平台镜像并推送到华为云 SWR（构建方式见第 13 节）。网关拉不到 Docker Hub、或不想在网关上构建时直接使用：

```bash
# deploy/.env
PS_IMAGE=swr.cn-east-3.myhuaweicloud.com/sreyun/ps-platform:1.3.0

docker compose pull platform           # 拉取平台镜像（nginx 镜像同样从 NGINX_IMAGE 拉取）
docker compose up -d --no-build
```

| 镜像标签 | 含义 |
|---|---|
| `1.3.0` | 固定版本（**生产环境推荐**，升级时显式修改） |
| `1.3` / `1` | 该次版本 / 主版本的最新发布 |
| `latest` | 最新正式发布 |
| `sha-xxxxxxx` | 对应某次提交，排查问题时使用 |

升级：修改 `PS_IMAGE` 的版本号后重复上面两条命令。私有仓库需先 `docker login swr.cn-east-3.myhuaweicloud.com`（登录指令在华为云 SWR 控制台「我的镜像 → 客户端上传」中获取）。演示叠加的 `demo-agent` 镜像仍在本地构建。

## 4. 方式 B：Windows / Linux 直接运行（可执行程序或 Node.js）

### 4.1 获取程序

| 系统 | 发布包 | 可执行文件 |
|---|---|---|
| Windows x64（10 / Server 2016 及以上） | `ps-platform-<版本>-windows-x64.zip` | `ps-platform.exe` |
| Linux x64（glibc ≥ 2.28：CentOS/RHEL 8+、Ubuntu 20.04+、Debian 10+、麒麟/统信等） | `ps-platform-<版本>-linux-x64.tar.gz` | `ps-platform`（无扩展名） |

发布包内含：可执行文件（无需安装 Node.js）、`admin/`、`public/`、`config.example.json`、`nginx/`、`docs/`、`QUICKSTART.txt`（快速上手）。整个目录拷贝到目标机器即可。

- 获取：从发布页（GitHub Releases）下载，或自行打包。
- 自行打包：`npm install && npm run build:exe`（需 Node.js ≥ 25.5）。**在哪个系统打包就生成哪个系统的程序**：Windows 上得到 `.exe`，Linux 上得到无扩展名的可执行文件（Linux 请用 glibc 版 Node，例如 `docker run --rm -v $PWD:/src -w /src node:26-bookworm-slim sh -c "npm ci && npm run build:exe"`）。产物在 `dist/`；Windows 上打包会同时编译渲染机安装程序 `ps-platform-agent-setup-<版本>.exe`（使用系统自带的 .NET Framework 4.x 编译器，源码在 `agent-setup/`）。
- 源码运行：`npm install --omit=dev && node server.js`（Node.js ≥ 22.13）。

### 4.2 配置与启动

Windows：

```powershell
cd D:\ps-platform
copy config.example.json config.json    # 按第 6 节修改
.\ps-platform.exe
```

Linux：

```bash
tar -xzf ps-platform-<版本>-linux-x64.tar.gz -C /opt && cd /opt/ps-platform-<版本>-linux-x64
cp config.example.json config.json      # 按第 6 节修改（Linux 上通常 localAgent.enable=false，渲染机另行接入）
./ps-platform
```

首次启动会在 `data/` 下创建数据库，并把随机的 admin 口令写到 `data/initial-admin.txt`（或启动前设置环境变量 `PS_ADMIN_PASSWORD`）。登录后请立即修改口令并删除该文件。

单机部署（网关与 UE 在同一台 Windows）：保持 `localAgent.enable: true`，平台内置"本机"Agent，**无需另外运行 Agent**；把 UE 所在目录写进 `localAgent.allowExe`。

### 4.3 注册为系统服务（开机自启）

Windows（NSSM）：

```powershell
nssm install ps-platform D:\ps-platform\ps-platform.exe
nssm set ps-platform AppDirectory D:\ps-platform
nssm set ps-platform AppStopMethodConsole 5000      # 正常停止：平台会结束本机拉起的 UE
nssm set ps-platform AppExit Default Restart
nssm start ps-platform
```

Linux（systemd）：

```ini
# /etc/systemd/system/ps-platform.service
[Unit]
Description=ps-platform
After=network-online.target

[Service]
WorkingDirectory=/opt/ps-platform
ExecStart=/opt/ps-platform/ps-platform
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now ps-platform && journalctl -u ps-platform -f
```

监听 1024 以下端口（默认管理口 88）需要 root，或改用 ≥1024 的端口，或 `setcap 'cap_net_bind_service=+ep' /opt/ps-platform/ps-platform`。

### 4.4 nginx（Windows）

使用 `nginx/nginx.conf`，按文件头注释修改：去掉 `reuseport`、`so_keepalive=...` 改为 `so_keepalive=on`、日志路径改为 `logs/...`、证书路径改为本机路径。
Windows 版 nginx 单 worker 并发约 1000 连接；观众较多时建议用 Linux 网关。本机验证可直接用 `nginx/nginx.local-test.conf`（高位端口，见文件头）。

## 5. 渲染机接入（Agent）

每台渲染机运行一个 Agent（单机部署时平台已内置"本机"Agent，跳过本节）。Agent 与平台是同一个程序（以 `--agent` 运行），负责上报 CPU、内存、NVIDIA GPU（nvidia-smi）与进程，并按平台调度启动 / 停止 UE。

### 5.1 Windows 10 / 11：图形安装（推荐）

1. 管理端「渲染机 / GPU → 接入渲染机 → Windows（图形安装）」点 **复制安装链接**（仅管理员可见，24 小时内有效），在渲染机的浏览器中打开，下载 `ps-platform-agent-setup.exe`。也可以点「直接下载」后用 U 盘 / 共享文件夹拷贝过去。
2. 在渲染机上双击运行（需要管理员权限），按向导点「下一步」：
   - **连接平台**：平台地址与接入令牌已包含在安装程序中，向导自动检测连接；
   - **本机设置**：机器名称（默认计算机名）、UE 程序所在文件夹（安全白名单，可添加多个）；
   - **安装选项**：安装位置（默认 `C:\Program Files\ps-platform-agent`）与运行方式（见下表）。
3. 安装完成后本机自动出现在「渲染机 / GPU」列表中。

| 运行方式 | 说明 |
|---|---|
| 开机自动运行（Windows 服务，**默认**） | 无需登录 Windows，开机即接入平台，适合无人值守的渲染机。平台启动 UE 时总会加 `-RenderOffScreen`（无窗口渲染），服务方式下也能出图 |
| 登录 Windows 后自动运行（计划任务） | 在当前用户的桌面会话中运行。个别显卡驱动 / UE 插件在服务方式下无法出图时使用；电脑重启后需登录 Windows（无人值守可用 `netplwiz` 设置自动登录） |

- **修改设置**（机器名称、UE 目录、运行方式、平台地址）：再次运行安装程序，或在 Windows「设置 → 应用」中点「修改」。
- **升级**：从平台重新下载安装程序运行即可，沿用原有设置；正在运行的 UE 不受影响，新 Agent 启动后自动接管。
- **卸载**：Windows「设置 → 应用 → ps-platform 渲染节点 Agent → 卸载」。会停止 Agent、移除自动运行，并结束由 Agent 启动且仍在运行的 UE。
- 安装位置中的文件：`ps-platform.exe`（Agent）、`ps-agent.exe`（守护进程：Agent 退出后自动重启）、`data\agent.json`（配置，含令牌，只有 SYSTEM / 管理员可读）、`data\logs\agent-日期.log`（日志，保留 14 天）。
- 首次运行若出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」（安装程序未做代码签名）。
- 轮换接入令牌后，各渲染机重新下载安装程序运行一次即可（或修改 `data\agent.json` 中的 `token` 后重启服务 `ps-platform-agent`）。

**批量部署（静默安装）**：用安装链接下载的安装程序（已含平台地址与令牌），在 PowerShell 中以管理员身份执行：

```powershell
Start-Process -Wait .\ps-platform-agent-setup.exe -ArgumentList '/S','/id=render-01','/allow-exe=D:\UEProject'
```

| 参数 | 说明 |
|---|---|
| `/S` | 静默安装，结果写入 `%TEMP%\ps-platform-agent-setup.log` |
| `/id=` | 机器名称（默认计算机名） |
| `/allow-exe=` | UE 程序目录，多个用 `;` 分隔；路径含空格时把整个参数加双引号：`'"/allow-exe=D:\UE Project"'` |
| `/mode=` | `service`（默认）或 `logon` |
| `/dir=` | 安装位置 |
| `/url=` `/token=` | 不使用安装链接下载的安装程序（例如发布页下载的）时指定平台地址与令牌 |

卸载：`Start-Process -Wait "C:\Program Files\ps-platform-agent\ps-agent.exe" -ArgumentList '/uninstall','/S'`。

**安装程序从哪里来**：平台以 `ps-platform.exe` 运行时，启动后自动用自身生成（约 10 秒）；Docker / Linux 部署的平台需要获取一次——在「接入渲染机」中点 **从发布页获取**（下载 GitHub Releases 中同版本的 `ps-platform-agent-setup-<版本>.exe`，地址可用 `downloads.releaseBaseUrl` 改为内网镜像），或在能上网的电脑下载后点 **上传**。文件保存在 `data/downloads/`，平台升级后建议重新获取。

### 5.2 Linux 渲染机

「接入渲染机 → Linux」复制命令执行（先在该页获取一次 Linux Agent，方法同上，发布页文件为 `ps-platform-agent-<版本>-linux-x64`）：

```bash
curl -fL -o ps-platform http://192.168.1.10:88/download/agent/linux && chmod +x ps-platform
./ps-platform --agent --url ws://192.168.1.10:88/agent --token <令牌> --id render-01 --allow-exe /opt/ue
```

开机自启用 systemd（同 4.3，`ExecStart` 改为上面的 `--agent ...` 命令）。

### 5.3 命令行参数（Windows / Linux 通用）

```powershell
.\ps-platform.exe --agent --url ws://192.168.1.10:88/agent --token <令牌> --id render-01 --allow-exe D:\UEProject
# 或：.\ps-platform.exe --agent --config agent.json      源码：node agent/agent.js --url ...（Node.js ≥ 22.13）
```

Windows 的 Agent 程序本身可从 `http://<平台>:88/download/agent/windows-exe` 下载（「接入渲染机 → 命令行 / 批量部署」有现成命令）。

| 参数 | 说明 |
|---|---|
| `--url` | 平台管理口地址（内网）。也可用环境变量 `PS_AGENT_URL` |
| `--token` | Agent 令牌（`PS_AGENT_TOKEN`）。轮换后所有 Agent 需用新令牌重启 |
| `--id` | 机器 ID（默认主机名），在管理端显示，也用于程序的"指定机器 / 各机器路径" |
| `--allow-exe` | **强烈建议**。只允许启动该目录下的程序（按目录边界匹配，解析符号链接），可重复。Windows 路径不要写成 `"D:\UE\"`（`\"` 会被当成转义的引号） |
| `--config` | JSON 配置文件 `{url, token, id, allowExe:[], state, insecure}`（安装程序使用，令牌不出现在命令行中）；命令行参数优先 |
| `--state` | 进程表文件（默认系统临时目录）。Agent 或平台异常重启后据此接管仍在运行的 UE |
| `--insecure` | wss 自签名证书时跳过校验 |

无 NVIDIA 显卡时可在机器「设置」中手动定义 GPU 与显存，平台按程序的"估算显存"放置。

UE 由平台按程序配置拉起，平台自动追加：`-PixelStreamingURL=ws://<网关>:88/ue/<程序>/<实例>`、`-graphicsadapter`、`-RenderOffScreen`、`-Unattended`、分辨率/帧率/码率、`-AudioMixer`（可关）。程序"启动参数"里写的同名参数优先。

**手动启动的 UE**（不经平台）：`-PixelStreamingURL=ws://<网关>:88/<程序ID>`，会作为"手动实例"加入该程序（兼容旧版 `ws://网关:88/`，加入 `default` 程序）。

## 6. 配置参考

### 6.1 config.json（启动配置，修改后重启生效）

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `./data` | 数据库、日志、自定义网页目录 |
| `http.port` / `http.host` | 88 / 0.0.0.0 | 管理口 |
| `http.publicPort` / `http.publicHost` | 8088 / 127.0.0.1 | 观众口（只给 nginx 访问） |
| `http.tls` | null | `{cert,key,admin}`：不经 nginx 直接提供 https/wss。默认只作用于观众口；`admin:true` 时管理口也启用（UE 需 `wss://`） |
| `gateway.ueHost` | auto | UE 连接平台用的 `host:port`；auto = Agent 连接平台时用的地址 |
| `security.trustProxy` | 127.0.0.1, ::1 | 信任其 `X-Forwarded-For` 的代理 |
| `security.adminAllow` | 私网段 | 允许访问管理端/API/metrics 的网段 |
| `security.engineAllow` | 私网段 | 允许以 UE / Agent 身份连接的网段 |
| `security.lanNetworks` | [] | 额外视为"内网"的网段（决定是否当作外网观众） |
| `security.sessionTtlHours` | 8 | 管理端登录有效期 |
| `localAgent.enable` | true | 内置本机 Agent（docker 中为 false） |
| `localAgent.allowExe` | [] | 本机 Agent 允许启动的目录 |
| `localAgent.killOnStop` | true | 平台正常停止时结束本机 UE |
| `turn.forceRelay` | false | 首次启动的强制中继策略（之后以管理端为准） |
| `turn.servers` | [] | 首次启动写入的额外 STUN/TURN |
| `turn.builtin.enable` | false | 内置 TURN（docker 中为 true） |
| `turn.builtin.listen` | 127.0.0.1:3478 | TURN TCP 监听（nginx 转发到这里） |
| `turn.builtin.relayIp` | auto | 中继 UDP 绑定的内网 IP（UE 必须能访问） |
| `turn.builtin.minPort/maxPort` | 49160/50159 | 中继端口段，容量 ≈ 端口数 / 2 |
| `turn.builtin.allowedPeers` | 私网段 | 只允许中继到这些地址（防止被当作开放代理） |
| `turn.builtin.workers` | auto | TURN worker 进程数（min(4, CPU 核数)） |
| `turn.builtin.httpFallback` | null | 同端口明文 http：设为 nginx 内部 http 入口 `127.0.0.1:3480` 后，对外端口同时支持 `http://`（docker-compose 默认开启） |
| `downloads.releaseBaseUrl` | GitHub Releases（`…/releases/download/v{version}`） | 「接入渲染机」一键获取 Agent 安装包的地址，`{version}` 替换为平台版本；内网可改为自建镜像（目录中放同名文件），空字符串 = 不提供一键获取。经代理访问外网时设置环境变量 `HTTPS_PROXY` 并加 `NODE_USE_ENV_PROXY=1` |
| `history.retentionDays` | 90 | 会话/审计保留天数 |
| `log.level` / `log.retentionDays` | info / 14 | 日志级别、文件保留天数 |

### 6.2 环境变量（覆盖 config.json）

| 变量 | 对应 |
|---|---|
| `PS_CONFIG` | 配置文件路径 |
| `PS_DATA_DIR` `PS_PORT` `PS_HOST` `PS_PUBLIC_PORT` `PS_PUBLIC_HOST` `PS_UE_HOST` `PS_SITE_DIR` `PS_LOG_LEVEL` | 同名配置 |
| `PS_ADMIN_ALLOW` `PS_ENGINE_ALLOW` `PS_TRUST_PROXY` `PS_LAN_NETWORKS` | 逗号分隔网段 |
| `PS_LOCAL_AGENT` `PS_LOCAL_AGENT_ALLOW_EXE` | 本机 Agent |
| `PS_TLS_CERT` `PS_TLS_KEY` `PS_TLS_ADMIN` | 内置 TLS |
| `PS_RELEASE_BASE_URL` | `downloads.releaseBaseUrl` |
| `PS_ADMIN_PASSWORD` | 首次启动的 admin 口令 |
| `PS_PUBLIC_BASE_URL` | 首次启动写入的「对外访问地址」，例如 `https://ue.example.com:8443`（之后以管理端为准） |
| `PS_JWT_SECRET` `PS_AGENT_TOKEN` `TURN_SECRET` | 固定密钥（默认随机生成存数据库） |
| `TURN_BUILTIN` `TURN_LISTEN` `TURN_RELAY_IP` `TURN_MIN_PORT` `TURN_MAX_PORT` `TURN_WORKERS` `TURN_ALLOWED_PEERS` | 内置 TURN |
| `TURN_FORCE_RELAY` | false / true / external |
| `TURN_HTTP_FALLBACK` | 同端口明文 http 的内部入口（docker-compose 中由 `INT_HTTP` 决定，默认 127.0.0.1:3480） |
| `DC_TURN_URLS` `DC_TURN_SECRET` | 自建数据中心 STUN/TURN（coturn use-auth-secret） |
| `UE_TURN_URLS` `UE_TURN_SECRET` | 只下发给 UE 的 TURN（默认用内置 TURN 密钥） |

### 6.3 运行期设置（管理端「系统设置」，立即生效）

TURN/ICE 服务器（`{host}`/`{port}` 自动替换为浏览器实际访问的地址；`scope` = player/ue/all；`audience` = all/external/lan）、强制中继、每 IP 观众上限、观众 IP 白名单、CORS 来源、工具接口是否公开、限流、告警 Webhook（企业微信/钉钉/飞书/通用 JSON）、API 令牌、备份/恢复。

## 7. 访问地址与嵌入其它系统

所有地址都走 nginx 的同一个对外端口，**http:// 与 https:// 都可以**（例如 `http://203.0.113.10:61556/…` 与 `https://域名:61556/…`）：

| 地址 | 说明 |
|---|---|
| `http(s)://<主机>:<端口>/video.html?urlPrefix=<程序ID>` | **与企业版完全一致**，原有链接/嵌入代码无需修改 |
| `http(s)://<主机>:<端口>/play/<程序ID>` | 推荐的新写法 |
| `http(s)://<主机>:<端口>/<程序ID>` | 兼容写法 |
| 追加 `&token=…` | 程序设置了"需要访问链接"时，用管理端「访问链接」生成的令牌 |
| 追加 `stats=1` / `relay=1` / `ui=0` | 显示状态浮层 / 强制只走中继 / 隐藏播放页控制栏（嵌入时使用） |

- **从企业版迁移**：在新平台创建与原 `urlPrefix` 同名的程序即可。程序 ID 不区分大小写（`JJQ` 保存为 `jjq`，`urlPrefix=JJQ`、`/play/jjq`、`/JJQ` 都能访问）。
- **嵌入**：

```html
<iframe src="http://203.0.113.10:61556/video.html?urlPrefix=JJQ"
        allow="autoplay; fullscreen; clipboard-read; clipboard-write" style="border:0;width:100%;height:100%"></iframe>
```

- **在管理端获取**：「程序与访问」每个程序的「访问」按钮列出推荐地址、企业版兼容地址、全屏演示页与 iframe 嵌入代码（基于「对外访问地址」生成，一键复制）；需要访问链接的程序可在面板中直接生成带令牌的地址。
- **播放页体验**：显示连接进度（连接 → 分配实例 → 建立画面）与排队人数；浏览器拦截自动播放时提示"点击开始观看"/"开启声音"；无操作自动断开前 30 秒倒计时；被拒绝/踢出/链接失效时给出明确原因并停止自动重连，可一键重新连接。
- **全屏嵌入效果演示**：`http(s)://<主机>:<端口>/embed-demo.html?urlPrefix=<程序ID>[&token=…]`——模拟业务系统把画面全屏嵌入，点击进入浏览器全屏，顶部工具栏可查看/复制嵌入代码。
- **http 还是 https**：业务系统是 http 页面 → 两种都能嵌；业务系统是 **https 页面 → 必须嵌 https 地址**（浏览器禁止混合内容），且需要**受信任的证书**（域名证书）：iframe 里的自签名证书错误页无法点"继续访问"。只有 IP、没有正式证书时请让业务系统用 http 嵌入，或给网关配一个域名证书。
- 播放页不发送 `X-Frame-Options`，可被任意系统嵌入；如需限制嵌入方，在 nginx 的 server 中加 `add_header Content-Security-Policy "frame-ancestors https://oa.example.com" always;`。
- 默认不启用 HSTS（启用后浏览器会把该域名的 http 链接强制升级为 https，自签名证书时无法继续访问）。使用正式证书且不再需要 http 时可在 nginx.conf 中打开。

## 7.1 管理端使用要点

- **程序**：一个 UE 应用一个程序。模式"独占"= 一人一实例；"共享"= 多人同看。预热实例数（可按时段 `8-20`）、最大实例数、空闲释放秒数、启动超时、分辨率/帧率/码率、估算显存、指定机器、各机器不同安装路径、观众 IP 白名单、同 IP 只留一个会话、无操作自动断开、隐藏鼠标。
- **允许观众执行 UE 控制台命令**（`-AllowPixelStreamingCommands`）默认关闭：开启后任何观众都能通过数据通道执行 `quit` 等命令，只在可信内网场景开启。
- **访问链接**：程序勾选"需要访问链接"后，观众只能通过带令牌的链接进入；可设有效期与次数（同一观众刷新/重连不重复计数），可随时作废。
- **用户**：管理员 / 运维 / 只读三种角色；支持两步验证（TOTP）、强制下线、重置两步验证。改口令、禁用、改角色后该用户所有登录立即失效。登录连续失败按来源 IP 和用户名分别锁定 5 分钟。
- **API 令牌**（二次开发）：`Authorization: Bearer psk_...`，按角色授权，可设有效期、随时吊销；不能调用账户安全相关接口。接口见 `docs/API.md`。
- **运行日志 / 审计日志 / 会话历史**：日志页实时过滤；审计记录所有写操作；会话记录时长、码率、RTT、帧率、链路类型。

## 8. 网络场景：内网 / 跨网 / 映射端口 / 自建 TURN

| 场景 | 需要做什么 |
|---|---|
| 内网观众 | 无需配置。ICE 优先直连 UE（不占中继） |
| 外网观众经路由器端口映射（如 外网 6443 → 网关 443） | 无需配置。平台按浏览器访问的 `host:端口` 生成 TURN 地址（`turn:外网IP:6443`），映射多少端口都行 |
| 域名 + 受信任证书 | 放好证书即可，浏览器会同时使用 `turns:`（穿透只放行 443/TLS 的企业防火墙） |
| 自建数据中心 coturn | `.env` 设置 `DC_TURN_URLS`/`DC_TURN_SECRET`，或在「系统设置 → TURN」添加，scope 选 all（UE 与观众都下发临时凭据） |
| 观众网络严格（只允许 TCP 443） | 设置强制中继 `external`（只对外网观众）或 `true` |
| 专线/VPN 分支机构算内网 | `security.lanNetworks` / `LAN_NETWORKS` |

### 8.1 网关前面还有一层 HTTP 反向代理（路由器反代、1Panel/OpenResty、Nginx Proxy Manager、云负载均衡、CDN）

常见形态：`https://ue.example.com:8443` 由前置反代（持有正式证书）终止 TLS，再反代到网关 `http(s)://网关:443`。

- **网页与信令可以经过前置反代**：要求支持 WebSocket（Upgrade/Connection 头）、保留原始 `Host`（含端口）、转发 `X-Forwarded-For`；读超时 ≥ 60 秒（信令每 30 秒心跳）。
- **视频媒体（TURN）不能经过纯 HTTP 反代**：浏览器的 TURN 连接到反代端口会得到 `400 Bad Request`，表现为"页面能打开、一直连接中/没有画面"。两种解决方式：

  **方案 A（推荐，不增加端口）：前置 nginx/OpenResty 用 stream 四层分流。** 按 [deploy/nginx/front-proxy.example.conf](../deploy/nginx/front-proxy.example.conf) 配置：
  前置代理的对外端口改由 `stream { ssl_preread on; }` 接收——本域名带 ALPN 的 TLS 进 https 反代（网页、wss）；
  本域名不带 ALPN 的 TLS（浏览器的 TURNS）由前置代理用正式证书终止后，把明文 TURN 交给网关；明文连接留在前置代理（跳转 https），
  其它域名照旧。证书仍由前置代理持有，网关与 ps-platform 无需改 TURN 配置（默认下发的 `turns:{host}:{port}` 即生效）。
  要求：前置代理回源用 `http://网关:端口`、保留 `Host`、带 `X-Forwarded-Proto https` 与 `X-Forwarded-For`（示例配置已包含）。

  **方案 B：路由器另开一个纯 TCP 端口转发**（四层转发，不是反向代理）到网关对外端口，例如 外网 TCP 8444 → 网关:443；
  然后在「系统设置 → TURN 服务器」添加 `turn:{host}:8444?transport=tcp`（密钥 `@builtin`，范围 player）。浏览器会同时尝试，哪条通用哪条。
- **观众真实 IP**：把前置反代连到网关时的内网地址填入 `UPSTREAM_PROXIES`（docker-compose）或 `security.trustProxy`，否则所有外网观众都显示为反代的地址，
  "同 IP 单会话 / 每 IP 上限 / 限流 / 内外网判断"都会失真。只填真正的代理地址，平台按 X-Forwarded-For 从右往左取第一个不可信地址，客户端无法伪造。
- 自检：`node test/e2e/…` 之外，最简单的是在外网电脑上打开播放页点「状态」，链路应为 `TURN 中继(tcp)`；或用任意 TCP 工具确认转发端口能连通。

## 9. 部署验证清单

```bash
# 1) 进程与健康
docker compose ps                                   # 或 Windows 服务状态
curl -s http://127.0.0.1:88/healthz                 # agents ≥ 1，turn = up
curl -s http://127.0.0.1:9180/healthz               # 经 nginx 到观众口
# 2) 对外端口多路复用（在网关上执行）
curl -sk https://127.0.0.1/healthz                  # 网页走 https（curl 带 ALPN）
# 3) 公网不能冒充 UE / Agent（应返回 403）
curl -sk -o /dev/null -w "%{http_code}\n" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Protocol: ps-agent" https://127.0.0.1/agent
```

4) 浏览器打开 `https://<网关>/play/<程序>`，点左下角「状态」：外网应显示 `TURN 中继(tcp)`，内网显示 `内网直连`，帧率稳定、丢包 0。
5) 管理端「观众会话」可看到该观众的码率、RTT、帧率、链路类型。
6) 并发压测（模拟渲染机 + 观众，不需要真实 UE；会临时关闭观众连接限流并在结束后恢复）：

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node test/load/platform-load.js --admin http://127.0.0.1:88 --public wss://127.0.0.1:443 \
  --user admin --password '<口令>' --agents 20 --players 300 --rate 100
```

经 nginx 时单个来源 IP 受 `limit_conn 500` 限制；更大规模直接打观众口 `--public ws://127.0.0.1:8088`。

## 10. 排障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| nginx 不断重启（Restarting），日志 `cannot load certificate "/etc/nginx/certs/fullchain.pem"` | 1.2.2 及更早版本的部署文件要求必须有证书 | 更新部署文件（`git pull` 或覆盖 `deploy/`）后 `docker compose up -d`：没有证书时自动以仅 http 模式运行（见 3.2）；或按 3.2 生成自签名证书后 `docker compose restart nginx` |
| 播放页一直"排队中" | 没有可用实例：Agent 离线 / 程序未配置可执行文件 / 达到最大实例数 / 显存不足 | 管理端「概览」与「程序」的错误提示；「运行日志」搜索 `没有可用的机器` |
| 实例反复"启动失败" | 路径错误、不在 `--allow-exe` 目录、UE 未连上平台 | 日志 `启动失败：…`；检查 UE 能否访问 `ws://网关:88`（防火墙放行 88），`engineAllow` 是否包含渲染机网段 |
| 黑屏，状态显示连接中 | ICE 不通：TURN 未运行、`relayIp` 不是 UE 可达的内网 IP、`allowedPeers` 不含 UE 网段 | `/healthz` 中 turn=up；日志 `relay <IP>`；渲染机 ping 网关 IP；放行网关 UDP 中继端口段（内网） |
| 外网能打开页面但没画面 | nginx 未做 TURN 分流（用了普通 http 反代）、端口映射到了错误端口 | 使用本项目的 nginx 配置；stream 日志里应有 `-> 127.0.0.1:3479/5349` 的 TURN 连接 |
| 健康检查打 443 失败 | 探活工具不发 ALPN，被当成 TURNS | 改打 `127.0.0.1:9180/healthz` |
| `http://IP:端口/` 打不开（https 正常） | 未启用同端口明文 http | 平台 `turn.builtin.httpFallback` 设为 `127.0.0.1:3480`，nginx 有 `listen 127.0.0.1:3480 proxy_protocol` 的 server；使用外部 coturn 时不支持（改用 https 或单独的 http 端口） |
| 所有新启动的实例都没有画面（观众端停在"正在连接"，浏览器控制台收到 offer 但收不到 UE 的 candidate） | 「系统设置 → TURN」中 scope=ue 的条目地址不可达（例如改成了公网 IP），UE 拿不到中继 | UE 与内置 TURN 同机时应为 `turn:127.0.0.1:<TURN 端口>`；内网真实 UE 一般不需要 UE 专用 TURN（直接连浏览器的中继地址）。改完后已运行的实例需重启才生效 |
| https 页面里嵌入后空白 | 混合内容（https 页面嵌 http 地址）或自签名证书 | https 业务系统嵌 https 地址，并使用受信任证书 |
| UE 连接被拒（日志 `拒绝来自 … 的 UE 连接`） | 来源不在 `engineAllow`，或经 nginx 访问了观众口 | UE 直连管理口 `ws://网关:88`；补充网段 |
| UE 连接被关闭 4009 | 该实例已被平台停止（防止"僵尸"UE 接管观众） | 正常现象；平台会自动停止该进程 |
| 观众被断开：4003 / 4005 / 4006 / 4002 | 需要访问链接 / 同 IP 新会话替换 / IP 不在白名单 / 长时间无操作 | 按程序设置调整 |
| 观众连接 HTTP 429 | 同一 IP 新建连接过快（默认 20/s、突发 100） | 「系统设置 → 安全」调整限流；企业 NAT 适当调大 |
| 管理端 403 "当前网络不允许访问管理接口" | 来源 IP 不在 `adminAllow` | 修改 `adminAllow` / `ADMIN_SUBNETS` |
| Agent 反复离线/上线 | 网络不稳、令牌错误（日志 `Agent 令牌错误`） | 检查令牌与网络；Agent 每 30s 心跳，连续 2 次无响应才判离线 |
| 偶发 502 | nginx upstream keepalive 超时大于平台 | 使用本项目配置（nginx 60s < 平台 65s） |
| 忘记管理员口令 / 两步验证手机丢失 | — | 另一个管理员在「用户」中重置；或在网关执行 `ps-platform.exe --reset-password admin`（docker：`docker compose exec platform node server.js --reset-password admin`），新口令写入 `data/initial-admin.txt`，同时清除两步验证、使旧登录失效。平台运行中可直接执行 |

日志位置：docker `docker compose logs -f platform`；直接运行 `data/logs/platform-YYYY-MM-DD.log`；管理端「运行日志」。

## 11. 日常运维

- **备份**：管理端「系统设置 → 备份」导出 JSON（程序、机器设置、运行期设置；不含用户与密钥）；或直接备份 `data/` 目录（停服务或使用 sqlite `.backup`）。恢复为原子操作（任一条目非法则整体不生效）。
- **监控**：`http://<网关>:88/metrics`（Prometheus，仅 `adminAllow` 网段），关键指标 `psp_viewers`、`psp_viewers_queued`、`psp_instances_*`、`psp_turn_*`、`psp_event_loop_delay_p99_ms`（持续 >100 说明过载）。
- **告警**：「系统设置 → 告警」配置 Webhook，事件：渲染机离线、实例启动失败、资源不足、排队积压、TURN 异常、登录锁定。
- **证书续期**：平台每分钟检测证书文件变化自动加载；nginx 需 `nginx -s reload`（docker：`docker compose exec nginx nginx -s reload`）。
- **容量**：信令 1000 并发 p99 约 300ms、内存约 120MB；中继带宽约 600Mbps / 8 核（见第 12 节）。超出时增加网关（多个网关各自接入不同渲染机）。

## 12. 实测记录（测试服务器）

环境：Debian 13、8 核、31GB、Docker 29.9 / compose v5.6，网关内网 IP `192.168.10.31`，与 peer-stream 演示及其它 10+ 个业务容器共用一台机器，因此使用了非默认端口：

| 项 | 值 |
|---|---|
| 部署目录 | `/opt/ps-platform`（compose 项目名 `ps-platform`，`deploy/.env` 权限 600，admin 口令见其中 `PS_ADMIN_PASSWORD`） |
| 观众入口（nginx 多路复用） | `https://192.168.10.31:9443/`（自签名证书） |
| 管理端 | `http://192.168.10.31:18800/admin/`（允许 127.0.0.0/8、192.168.10.0/24） |
| 观众口 / TURN / 中继端口 | 127.0.0.1:18801 / 127.0.0.1:13478 / UDP 50200-50399 |
| 演示 | `docker-compose.demo.yml`：demo-agent（无头 Chromium 作 UE）；程序 `demo`（独占，预热 1）、`demo-shared`（共享，10 人/实例）、`jjq`（演示企业版地址 `video.html?urlPrefix=JJQ`） |

外网查看（没有映射端口时经 SSH 隧道，只有一条 TCP 通路，相当于最严格的客户网络）：

```bash
ssh -p <SSH端口> -L 9443:127.0.0.1:9443 -L 18800:127.0.0.1:18800 <用户>@<服务器地址>
# 浏览器：https://127.0.0.1:9443/  （观众）   http://127.0.0.1:18800/admin/  （管理端）
```

结果（2026-11-24）：

| 项目 | 结果 |
|---|---|
| 容器 | platform、nginx healthy；TURN 4 worker，中继地址 192.168.10.31 |
| 远程播放（本机经 SSH 隧道） | `relay/tcp → relay`，0 丢包，RTT ≈ 170ms（跨公网），1280x720 帧随带宽自适应（隧道上行约 3~4Mbps） |
| 7 个真实浏览器同时观看 | 独占程序 3 人 → 平台自动拉起 3 个实例 + 1 个预热；共享程序 4 人共用 1 个实例；全部 relay/tcp、23~30fps、0 丢包 |
| 全屏嵌入演示 | `/embed-demo.html?urlPrefix=JJQ&token=…`：画面铺满窗口；鼠标移动/点击/滚轮/键盘经数据通道回传，演示 UE 实时画出观众指针、点击涟漪与按键 |
| 企业版地址兼容 | `http://…:9443/video.html?urlPrefix=JJQ` 与 `https://…:9443/video.html?urlPrefix=JJQ` 同端口均可播放（relay/tcp，0 丢包）；在不同源页面中分别以 http / https iframe 嵌入，两路同时播放正常 |
| 经前置反代访问（https://ue.example.com:8443 → 路由器 → 192.168.10.22 OpenResty → 31:9443） | 网页、信令正常；TURN 到 8443 被 OpenResty 返回 400（无画面）→ 需在路由器增加 TCP 8444 → 192.168.10.31:9443 转发，平台已配置 `turn:{host}:8444`；信任 192.168.10.22 后外网观众真实 IP 正确识别 |
| 前置 nginx 四层分流（方案 A）本机复现：前置 nginx（按 front-proxy.example.conf 生成）→ 隧道 → 31:9443 | 分流自检 5/5（wss 信令下发 turns:、TURNS 到网关 TURN、明文不透传、http 跳转、其它域名不受影响）；浏览器连续 3 次播放均为 `relay/tls`（经前置代理的 TURNS），27~28fps、0 丢包 |
| 平台重启接管 | 重启 platform 容器后自动接管仍在运行的 UE（1 秒内重连），未重复拉起 |
| 并发 300（经 nginx 9443 的 wss，每人独占一个实例） | 300/300 拿到画面协商，p50 230ms / p99 328ms，20 台模拟渲染机每台 14~16 个实例，全部离开 5 秒内回收完毕 |
| 并发 1000（直连观众口） | 1000/1000，p50 211ms / p99 306ms，每台 50 个实例，内存 81→115MB，4.1 秒回收，0 错误 |

部署过程中发现并修复：① Agent 心跳未记录 pong，约每 60 秒被误判离线一次（导致启动中的实例失败）；② 连接限流误伤同一渲染机上的多个 UE（现只限制观众连接，默认 20/s、突发 100）。

## 13. 构建与发布（CI / 华为云 SWR）

仓库内置三条 GitHub Actions 工作流（`.github/workflows/`）：

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml`（ci） | 每次推送与 PR | Node 22 / 26 两个版本跑全部测试（失败原因写成注解，运行页面直接可见）；生产依赖漏洞审计；管理端 / 播放页 / 服务端脚本语法检查；平台镜像构建并启动自检（不推送） |
| `release.yml`（可执行程序） | 推送 `v*` 标签 | 校验标签与版本号一致 → 测试 → 分别在 Windows / Linux 上打包并冒烟测试 → 上传到该标签的 Release（zip、tar.gz、SHA256SUMS.txt） |
| `docker.yml`（镜像） | 推送 `v*` 标签 | 校验标签与版本号一致 → 构建 amd64 镜像并启动自检（健康接口版本号须等于标签）→ 构建 amd64 + arm64 并推送到华为云 SWR → 漏洞扫描、SBOM、镜像签名（这三步失败不影响发布，结果写在运行摘要里） |

两条发布工作流都可在 Actions 页面手动运行（填写已存在的标签），用于给已有标签补发构建产物或镜像。

### 13.1 发布一个新版本

1. 修改版本号：`package.json` 的 `version` 与 `src/app.js` 的 `VERSION`（两处必须一致，发布工作流会校验）。
2. 在 `CHANGELOG.md` 增加 `## <版本>` 一节（会自动作为 Release 说明）。
3. 提交并推送 main，等 ci 通过后打标签：

```bash
git tag -a v1.2.3 -m "ps-platform 1.2.3"
git push origin v1.2.3
```

预发布版本（如 `v1.3.0-rc1`）只打完整版本号与 `sha-` 两个镜像标签，不会更新 `latest`、`1.3`。

### 13.2 配置华为云 SWR（首次）

1. 华为云控制台 → 容器镜像服务 SWR → 创建组织（默认用 `sreyun`，与下面的 `SWR_NAMESPACE` 一致）。
2. 统一身份认证 IAM → 为发布专用的 IAM 用户创建访问密钥（AK/SK），授予该组织的推送权限（SWR 中「组织 → 授权」给该用户编辑权限，或系统策略 `SWR Admin`）。
3. GitHub 仓库 → Settings → Secrets and variables → Actions：

| 类型 | 名称 | 值 |
|---|---|---|
| Secret | `HW_ACCESS_KEY` | AK |
| Secret | `HW_SECRET_KEY` | SK |
| Variable（可选） | `SWR_REGISTRY` | 仓库域名，默认 `swr.cn-east-3.myhuaweicloud.com`（华东-上海一）；其它区域如 `swr.cn-north-4.myhuaweicloud.com` |
| Variable（可选） | `SWR_NAMESPACE` | 组织名，默认 `sreyun` |
| Variable（可选） | `IMAGE_NAME` | 镜像名，默认 `ps-platform` |
| Variable（可选） | `NPM_REGISTRY` | 构建时的 npm 源，默认官方源 |

登录 SWR 用的用户名 / 口令由 AK/SK 在工作流中现场推导（用户名 `<区域>@<AK>`，口令为以 SK 为密钥对 AK 做 HMAC-SHA256 的十六进制），无需在控制台生成长期登录指令。组织级（Organization）同名 Secret 同样生效。

4. 配置后在 Actions 页面手动运行「Release · 镜像构建与推送（华为云 SWR）」并填写已有标签（例如 `v1.2.2`），即可补推该版本镜像。

镜像默认推送为私有。需要匿名拉取时，在 SWR 控制台把该镜像设为「公开」。
