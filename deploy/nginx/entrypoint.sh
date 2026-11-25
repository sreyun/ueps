#!/bin/sh
# ps-platform nginx 启动脚本（docker-compose 以 sh 调用，不依赖文件的可执行权限）。
#
# 按证书是否存在选择模式，然后交给官方镜像的 /docker-entrypoint.sh（envsubst 渲染模板并启动 nginx）：
#   有 fullchain.pem + privkey.pem → 完整模式：https / wss / TURNS + 明文 http / TURN（同一端口）
#   没有证书                         → 仅 http 模式：去掉需要证书的配置，http:// 与明文 TURN 照常可用
# 放入或更换证书后：docker compose restart nginx（续期同一路径的证书只需 nginx -s reload）
set -e

SRC=/etc/nginx/ps/nginx.conf.template
DST_DIR=/etc/nginx/templates
DST="$DST_DIR/nginx.conf.template"
CERT=/etc/nginx/certs/fullchain.pem
KEY=/etc/nginx/certs/privkey.pem

mkdir -p "$DST_DIR"
if [ -s "$CERT" ] && [ -s "$KEY" ]; then
	cp "$SRC" "$DST"
	echo "ps-platform: 已找到证书，启用 https / wss / TURNS（同端口同时提供 http:// 与明文 TURN）"
else
	# 删除 #@tls-begin … #@tls-end 之间的行；启用以 #@notls 开头的行。
	# 80 端口与对外端口相同时（例如都设为 80）不重复监听
	DROP_RE='^#@no-such-line@#$'
	[ "${PS_HTTP_PORT:-80}" = "${PS_MUX_PORT:-443}" ] && DROP_RE='#@notls listen .*PS_HTTP_PORT'
	sed -e '/#@tls-begin/,/#@tls-end/d' -e "/$DROP_RE/d" -e 's/^\([[:space:]]*\)#@notls /\1/' "$SRC" > "$DST"
	echo "ps-platform: 未找到 $CERT / $KEY，以仅 http 模式启动："
	echo "ps-platform:   http://<地址>:<对外端口>/ 与 80 端口可正常访问，https:// 暂不可用"
	echo "ps-platform:   放入证书后执行 docker compose restart nginx 即启用 https（见 docs/INSTALL.md 3.2）"
fi

exec /docker-entrypoint.sh "$@"
