#!/usr/bin/env bash
# 把 node:test 日志中的失败原因写成 GitHub Actions 注解：失败用例、断言信息与出错位置。
# 注解在运行页面与 API 中不登录也能看到，排查 CI 失败不必下载完整日志。
# 用法：annotate-test-log.sh <日志文件> <标题>
set -u
log="$1"
title="${2:-npm test}"
grep -E -- '^✖ |^\s*not ok |^\s+error: |AssertionError|Error \[|^\s+(actual|expected):|test/[a-z0-9_.-]+\.test\.js:[0-9]+' "$log" \
	| grep -v 'failing tests:' | head -12 | while IFS= read -r line; do
	printf '::error title=%s::%s\n' "$title" "$(printf '%s' "$line" | sed 's/%/%25/g')"
done
