# ps-platform 镜像（两个构建目标）
#   platform    管理平台：信令 + 调度 + 管理端 + 内置 TURN（默认目标）
#   demo-agent  演示用渲染节点：ps-platform Agent + 无头 Chromium（以 UE 身份推送测试画面，没有 UE 时查看整条链路）
#
# 构建（在 ps-platform 目录）：
#   docker build -f deploy/docker/Dockerfile -t ps-platform:1.1 .
#   docker build -f deploy/docker/Dockerfile --target demo-agent -t ps-platform-demo-agent:1.1 .
# 国内网络：--build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine --build-arg APK_MIRROR=https://mirrors.aliyun.com --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS platform
WORKDIR /app
ENV NODE_ENV=production \
    PS_DATA_DIR=/data \
    PS_LOCAL_AGENT=false
# 运行时只依赖 ws（node:sqlite 为 Node 内置）。国内网络可传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY lib ./lib
COPY agent ./agent
COPY admin ./admin
COPY public ./public
VOLUME ["/data"]
# 88：管理端 / UE / Agent（仅内网）  8088：观众口（仅 nginx 访问）  3478：内置 TURN（仅 nginx 访问）
EXPOSE 88 8088 3478
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PS_PUBLIC_PORT:-8088}/healthz" >/dev/null || exit 1
CMD ["node", "server.js"]

# Chromium 层只依赖基础镜像，代码变更时不需要重新下载（约 100MB）
FROM ${NODE_IMAGE} AS demo-base
ARG APK_MIRROR=
# Alpine 的 busybox sed 基础正则不支持 \? ，必须用 -E
RUN if [ -n "$APK_MIRROR" ]; then sed -i -E "s#https?://dl-cdn.alpinelinux.org#${APK_MIRROR}#g" /etc/apk/repositories; fi \
 && apk add --no-cache chromium ttf-dejavu font-wqy-zenhei

FROM demo-base AS demo-agent
WORKDIR /app
ENV NODE_ENV=production
COPY --from=platform /app /app
COPY test/e2e/fake-ue-launcher.js test/e2e/fake-ue.html ./test/e2e/
HEALTHCHECK NONE
# 平台下发的"UE 可执行文件"为 /usr/local/bin/node，参数为 /app/test/e2e/fake-ue-launcher.js（见 docker-compose.demo.yml）
CMD ["sh", "-c", "exec node server.js --agent --url \"$PS_AGENT_URL\" --id \"${PS_AGENT_ID:-demo}\" --allow-exe /usr/local/bin/ --state /tmp/ps-agent.json"]
