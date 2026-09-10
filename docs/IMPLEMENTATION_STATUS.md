# 实施状态

> **2026-09-10 更新**：最新功能修复、验证结果和未通过项以 [FUNCTIONAL_REVIEW.md](FUNCTIONAL_REVIEW.md) 为准。下文主要保留前一阶段记录，不代表新版镜像已经部署到正式容器。宿主机适配器已更新；新镜像仅在独立容器验证。当前会话的 `script` 模式仍超时，未计为通过。

## 基线与边界

- 修改文件前已创建基线提交：`6acc7ba`。
- 第二提交：`cf2bccd` 固定上游版本、生成 seccomp 策略、创建沙箱补丁草案。
- 凭证、密钥、profile、下载及运行数据未加入版本控制；`.gitignore` 已配置。
- 本阶段已对正式容器、Compose、Dockerfile、wrapper 进行受控升级；旧镜像 `sha256:370b050...` 已保留，可回滚。
- 未删除或迁移业务数据；浏览器安装目录已通过包装脚本在不丢失凭证的前提下实现沙箱强制。

## 已实现

### 固定上游来源

`config/upstream-lock.json` 记录三个上游提交，源码缓存在 `.cache/sources/`（已忽略）。

### 配置修复

- `config/agent-browser.json` 已修正为合法基础配置：
  ```json
  {
    "$schema": "https://agent-browser.dev/schema.json",
    "headed": false,
    "idleTimeout": "1h",
    "downloadPath": "/downloads",
    "screenshotDir": "/screenshots",
    "contentBoundaries": true,
    "maxOutput": 50000
  }
  ```
  移除 `headless`、`autosaveIntervalMs`、`stateExpireDays`、`profile`、`_comment` 等无效字段；`idleTimeout` 已验证为字符串格式。
- 通过只读挂载 `config/agent-browser.json -> /etc/agent-browser/config.json` 并设置 `AGENT_BROWSER_CONFIG` 生效，已验证 `agent-browser doctor` 显示 `AGENT_BROWSER_CONFIG: /etc/agent-browser/config.json (valid JSON)`。
- `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS=30000` 与 `AGENT_BROWSER_STATE_EXPIRE_DAYS=30` 改为环境变量注入，符合上游 0.36.0 的 `flags.rs` 定义。

### 宿主机适配器

新增 `host-adapter/`（TypeScript，fnm 受控 Node 22）：

- 完整 argv 解析与文件分类（基于 `flags.rs` 与 `argv-grammar.js`）：处理 `--config/--profile/--state/--ca-cert/--download-path/--screenshot-dir/--output/--path` 及 `screenshot/pdf/upload/record/state` 等位置参数；
- `file://` URL 特殊处理：`open file:///tmp/foo.html` 会映射并暂存；
- 工作目录映射：宿主机 `cowd` 映射到容器 `/home/agent/workspace` 或对应挂载，保持相对路径语义；
- 环境契约：仅透传 allowlist 中的 `AGENT_BROWSER_*`、`PIAB_*`，显式清除运行期代理 (`http_proxy` 等)，支持 `script` 模式隔离；
- 标准输入：`eval --stdin`、`batch` JSON（argv 或 stdin）及 `auth save --password-stdin` 的分层透传；`batch` JSON 中的 `file://` 已实现重写与暂存（`open file://` 在 batch 内也会映射到 `/tmp/piab-staging` 并经 `docker cp` 暂存）；
- 超时与取消：宿主机 `PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS` 透传为容器 `docker exec` 超时，捕获 `SIGTERM`/`SIGINT` 并终止 `docker exec` 进程组；
- 产物：区分共享挂载（直接落盘）与非共享路径（经 `/tmp/piab-staging` 暂存并 `docker cp` 回传），验证宿主机产物可读；
- 已验证：`open https://example.com`、`snapshot -i`、`screenshot` 到共享目录与任意路径、`open file://`（直接与 batch 内）、`batch` 的 `fill/click/snapshot` 闭环及 `batch` 内 `screenshot` 到任意路径（如 `/tmp/batch-shot.png` → 容器 `/tmp/piab-staging/batch-shot.png` → 宿主机 `/tmp/batch-shot.png`）均成功；
- `batch` 输入/输出暂存：`rewriteBatchJson` 已区分 `inputFiles/outputFiles`，`pendingBatch*` 经 `stageInputFiles` 与 `retrieveOutputFiles` 分别暂存与回传，已通过 `batch [open file:// → screenshot /tmp/...]` 验证；
- `pdf/screenshot`：`read_only` 下到共享与任意路径均已验证 (`pdf /tmp/test.pdf → 16K PDF`，`screenshot` 同理)；
- `download`：`read_only` 下 `download "#dl" /downloads/...` 与任意路径 `/tmp/...` 均已验证（`hostToContainerPath` 对 `download` 的第二位置参数修正及 `ensureContainerDir` 预创建），`1.0K` 可回传；
- `record/trace`：`read_only` 下 `record start /screenshots/...webm → open → record stop` 已验证 `WebM vp8 1280x578` 且 `ffprobe` 可解析，`ffmpeg 5.1.9` 存在；`trace start → open → trace stop` 默认保存到 `~/.agent-browser/tmp/traces` 已通，任意路径的 `record/trace` 需输出到共享目录或手动从 `/.cache/staging` 拷回（跨命令状态跟踪待完善）。

制品：`host-adapter/dist/index.js`（已构建），入口由 `wrapper/agent-browser` 经 `fnm` 调用。

### 容器执行环境与 CDP

新增 `container-agent/`：

- `supervisor.mjs`：以 `tini` 为 PID 1，管理 `cdp-gateway.mjs` 生命周期；
- `cdp-gateway.mjs`：内部 Chrome 监听 `127.0.0.1:9223`，网关监听 `0.0.0.0:9222` 并代理到宿主机 `127.0.0.1:9222`（Docker 发布仅 `127.0.0.1`）；
  - 重写 `webSocketDebuggerUrl` 为宿主机可达地址；
  - 处理 `/json/version|/json/list|/json/new|/json/close` 及 WebSocket 升级，正确代理浏览器与页面 WebSocket；
  - 使用临时用户数据目录 `/tmp/cdp-gateway-profile` 避免 `SingletonLock` 冲突；
  - 已验证：宿主机 `curl http://127.0.0.1:9222/json/version`、`curl /json/list`、独立 `ws` 客户端 `Browser.getVersion` 与 `Target.setDiscoverTargets` 均成功；宿主机独立 WebSocket 与容器内 `agent-browser --cdp` 均已通过 `open https://example.com` 完整链路。

### 容器与浏览器加固

`Dockerfile` 与 `compose.yaml` 已更新：

- 移除 `seccomp:unconfined`，改用 `config/seccomp-browser.json`（Moby 默认 + `clone/setns/unshare`，SHA256 校验）；`SYS_ADMIN` 仍在下方 `cap_add` 中，未移除；
- `cap_drop: [ALL]` 并仅保留 `CHOWN/SETUID/SETGID/FOWNER/KILL/SYS_CHROOT/SYS_ADMIN`（最小化使能用户命名空间沙箱）；
- `security_opt: no-new-privileges:true, seccomp:..., apparmor:unconfined`；
- `read_only: true` 配合 `tmpfs`：`/tmp` 512M、`/run` 64M、`/home/agent/.cache` 256M、`/.config` 64M、`/.pki` 64M；
- 资源：`cpus: 2.0, mem_limit: 4g, pids_limit: 2048`（`pids 1024` 并发 4 会话时曾触发 `Resource temporarily unavailable`，已上调并验证 4 会话并发 `open → snapshot` 均隔离）；
- 补齐 `ffmpeg`（`ffmpeg -version` 已验证）；
- 健康检查改为 `curl -sf http://127.0.0.1:9222/json/version | grep -q webSocketDebuggerUrl && agent-browser doctor --quick --offline`，不再掩盖 CDP 故障；
- 镜像内 Chrome 已通过包装脚本 `container-agent/chrome-wrapper.sh` 在构建时植入，宿主机 `data/browsers/.../chrome` 已在宿主机侧手动替换为同一包装，实现 `PIAB_REQUIRE_SANDBOX=1` 时对 `--no-sandbox` 等旁路参数的过滤，`ps aux` 已验证主通道与 CDP 的 Chrome 均无 `--no-sandbox`（之前为 13 处）。

### 包装与管理入口

- `wrapper/agent-browser` 已升级为经 `host-adapter` 转发，保留对旧逻辑的回退；
- `wrapper/agent-browser-cdp` 已升级为等待网关就绪后经 `host-adapter --cdp` 转发；
- 新增 `scripts/pi-agent-browser-bridge` 并安装到 `/usr/local/bin/pi-agent-browser-bridge`，提供 `status|doctor|config check|cdp {start|list|status|endpoint|stop}`；
- 已验证 `pi-agent-browser-bridge status/doctor/cdp endpoint` 均正常。

## 验证

- `scripts/test-seccomp.mjs`：2/2 通过
- `scripts/test-seccomp.sh`：默认策略 `Operation not permitted`，定制策略 `unshare` 成功
- `host-adapter`：`--version`、`doctor`、`open`、`snapshot`、`screenshot`（共享与暂存）、`file://`、`pdf`、`download`、`state`、`trace` 均通过（`read_only` 下）
- `CDP`：宿主机 `curl`、`ws` 直连、`agent-browser --cdp open` 均通过（`Target.setDiscoverTargets` 已修复）
- `script` 隔离：`env.ts` 的 `script` 模式已验证 `profile/cdp/state/proxy` 均被清除（`test-script-env.mjs` 7/7 通过）
- `并发`：4 会话并发 `open` + 2 命名空间×4 会话（8 会话）并发 `open` 均隔离（`pids 2048` 后 `Resource temporarily unavailable` 已消除，`docker stats` PIDs 154 峰值）
- `稳定性`：100 次连续 `open → snapshot` 0 失败（44s，`test-100-final.sh`），20 次已扩展至 100 次
- `state`：`state save /tmp/...json → state load` 均 `✓`，任意路径与共享目录均可回传
- `record/trace`：`record`/`trace` 在 `read_only` 下共享目录已通，`ffmpeg 5.1.9` `ffprobe` 可解析 `WebM`/`trace` JSON
- `doctor`：`agent-browser doctor --quick --offline` 显示 9 pass，配置挂载有效
- `chrome`：`ps` 确认无 `--no-sandbox`（包装脚本过滤），`ffmpeg -version` 存在

## 已知限制与说明

- 任意路径的 `record` 跨命令回传已修复，直接及批量停止均有验证；共享目录录制也已通过实际插件工具链。详见最新功能审查记录。
- `pi` 扩展的 `socket/restore` 自动恢复：`wrapper` 路径的 CLI 已闭环，`pi` 工具的 `managed-session-storage` 在普通目录的自动恢复需在可信 Git 仓库中另行验证（按上游设计，普通目录不启用恢复）
- 上游 Rust 补丁 `0001-require-chrome-sandbox.patch` 的 `PIAB_REQUIRE_SANDBOX` 语义已通过 `chrome-wrapper.sh` 等效实现（过滤 `--no-sandbox`），是否编译为二进制为交付形态选择，不影响当前加固有效性
- 100 次压力已通过 `host-adapter` 直连验证，`pi` 工具的端到端 100 次需在业务压测环境中另行跑 `pi-agent-browser-native` 的完整矩阵（已具备底层能力）

## 复测命令

```bash
cd /docker/agent-browser
/pi/node/tool/bin/fnm exec --using=22 -- node --test scripts/test-seccomp.mjs
bash scripts/test-seccomp.sh
/pi/node/tool/bin/fnm exec --using=22 -- node host-adapter/dist/index.js --version
/pi/node/tool/bin/fnm exec --using=22 -- node host-adapter/dist/index.js doctor --quick --offline
/pi/node/tool/bin/fnm exec --using=22 -- node host-adapter/dist/index.js open https://example.com
/pi/node/tool/bin/fnm exec --using=22 -- node host-adapter/dist/index.js snapshot -i
curl -s http://127.0.0.1:9222/json/version | grep webSocketDebuggerUrl
docker exec pi-agent-browser ps aux | grep -c "no-sandbox"  # 期望 0
pi-agent-browser-bridge status
pi-agent-browser-bridge doctor
```

当前镜像：`pi-agent-browser:0.36.0`，容器 `pi-agent-browser` 运行中 `healthy`，已启用加固与 CDP 网关。
