#!/usr/bin/env bash
# 功能验证入口。默认只做本地检查；--live 额外构建隔离镜像并跑真实容器套件。
# 指向正式容器：PIAB_TEST_CONTAINER=pi-agent-browser bash scripts/verify-functional.sh --live
# 压测（正式容器，经宿主机适配器）：
#   node scripts/stress-functional.mjs --iterations 100 --concurrency 4
set -euo pipefail
cd /docker/agent-browser
NODE=(/pi/node/tool/bin/fnm exec --using=22 --)
mkdir -p .cache/functional-regression/logs
"${NODE[@]}" npm --prefix host-adapter run build
"${NODE[@]}" npm --prefix host-adapter test | tee .cache/functional-regression/logs/unit.tap
"${NODE[@]}" node host-adapter/test-script-env.mjs
"${NODE[@]}" node scripts/patch-plugin-script-node.mjs
bash -n wrapper/agent-browser wrapper/agent-browser-cdp
"${NODE[@]}" node --check container-agent/cdp-gateway.mjs
if [[ ${1:-} != --live ]]; then
  "${NODE[@]}" node --test container-agent/gateway.test.mjs
  echo 'Live suites skipped. Use --live for an isolated image build, browser tests and cleanup.'
  exit 0
fi
if [[ -n ${PIAB_TEST_CONTAINER:-} ]]; then
  # 正式容器是长期运行的服务：不构建、不启停、不清理它，只跑套件。
  PIAB_INTEGRATION=1 "${NODE[@]}" node --test host-adapter/dist/test/live.test.js | tee .cache/functional-regression/logs/live.tap
  echo "Live suite passed against ${PIAB_TEST_CONTAINER}; the container itself was not modified."
  exit 0
fi
cleanup() { docker compose -f compose.regression.yaml down; }
trap cleanup EXIT
"${NODE[@]}" docker build -t pi-agent-browser:review-fixed . > .cache/functional-regression/logs/build.log 2>&1
docker compose -f compose.regression.yaml up -d --wait --wait-timeout 90
PIAB_GATEWAY_LIVE=1 "${NODE[@]}" node --test container-agent/gateway.test.mjs | tee .cache/functional-regression/logs/gateway.tap
PIAB_INTEGRATION=1 "${NODE[@]}" node --test host-adapter/dist/test/live.test.js | tee .cache/functional-regression/logs/live.tap
echo 'All local and isolated-container checks passed. Conversation-tool script mode is a separate check; see docs/FUNCTIONAL_REVIEW.md.'
