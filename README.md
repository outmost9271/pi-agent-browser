# Pi 浏览器容器桥接

宿主机运行 Pi 和 `pi-agent-browser-native`；容器运行 `agent-browser`、Chrome、ffmpeg 及 CDP 网关。

**最新审查、测试证据与已知限制见 [docs/FUNCTIONAL_REVIEW.md](docs/FUNCTIONAL_REVIEW.md)。插件 `script` 模式超时的根因（宿主 Pi 为 Node SEA，`process.execPath` 不是 Node）已定位并修复：`scripts/patch-plugin-script-node.mjs` 让沙箱 worker 使用真实 Node，需重启 pi 进程后生效（`/reload` 不足以清除模块缓存）；工具内复测已通过（最小脚本、真实浏览器调用、错误与策略负向用例）。外层超时取消已在适配器层和真实插件链路上通过验证。**

## 架构与版本

```text
Pi 原生工具 agent_browser
  → wrapper/agent-browser
  → host-adapter/dist/index.js（受控 Node 22）
  → docker exec：agent-browser 0.36.0
  → Chrome / ffmpeg

备用通道：container-agent/cdp-gateway.mjs → Chrome CDP
```

- 宿主机 Node ≥ 22.19，经 `/pi/node/tool/bin/fnm` 使用。
- Pi ≥ 0.84.0；当前安装插件版本 0.6.8。
- 上游 `agent-browser` 固定 0.36.0。
- 容器以 `node:20-bookworm-slim` 为基础；镜像内 Node 不承担 Pi 插件运行。
- 时区 `Asia/Shanghai`。下载代理仅用于构建，不透传通用运行期代理变量。
- 新镜像将浏览器放在 `/opt/piab/browser`，避免被空的持久化 data 挂载遮挡。

## 目录

| 路径 | 用途 |
| --- | --- |
| `Dockerfile`、`compose.yaml` | 正式部署镜像与编排 |
| `host-adapter/src/` | 参数、环境、文件、会话资源及取消处理 |
| `host-adapter/src/test/` | 单元、模拟 Docker、真实隔离容器回归 |
| `container-agent/` | CDP 网关、进程管理、Chrome 包装 |
| `wrapper/` | 宿主机受控入口，不自动启动正式容器 |
| `config/agent-browser.json` | 只读挂载的上游配置 |
| `data/`、`profiles/` | 业务状态、凭证与浏览器资料，不加入版本控制 |
| `downloads/`、`screenshots/` | 持久产物绑定挂载 |
| `.cache/staging/` | 请求级暂存；活动会话关闭前不可盲删 |
| `.cache/adapter-sessions/`、`.cache/recordings/` | 会话暂存与录制目标日志 |
| `compose.regression.yaml` | 不共享正式资料的独立测试容器 |

## 功能与边界

- 支持直接参数、标准输入批量以及原始命令字符串批量的路径映射。
- 每次调用只做两次容器往返（主命令与请求清理）；不对每个调用做 `docker inspect` 预检，容器不可用时通过 `docker exec` 报错并提示手动启动。
- 上传区分选择器与多文件；截图区分选择器与输出路径。
- 任意非共享输出通过容器内流式读取回传；使用请求 UUID 和源路径摘要隔离同名文件。
- 本地页面和上传输入保留至会话关闭，以便之后读取、提交或录制重新导航。
- 截图、PDF、下载、状态、trace、录制的返回元数据使用宿主机路径，让插件正确验证产物。
- 失败批量中已经成功的产物仍回传；失败或不确定的结果不冒充成功。
- profile 和默认产物目录必须使用已配置的持久绑定挂载路径；宿主机可执行文件、扩展目录及输入符号链接不作不可靠的隐式搬运。
- 超时先尝试关闭确切会话，必要时经身份核验终止其守护进程及子进程；入口脚本直接 exec 受控 Node，保证插件 SIGTERM 能及时到达适配器。已发出的业务动作不能回滚；清理未确认时不得自动重试变更操作。

## 验证

```bash
cd /docker/agent-browser
bash scripts/verify-functional.sh                      # 本地检查（含插件 script 补丁检查）
bash scripts/verify-functional.sh --live               # 隔离镜像 + 真实容器套件
PIAB_TEST_CONTAINER=pi-agent-browser bash scripts/verify-functional.sh --live   # 直接验证已部署容器
/pi/node/tool/bin/fnm exec --using=22 -- node scripts/stress-functional.mjs --iterations 100 --concurrency 4
/pi/node/tool/bin/fnm exec --using=22 -- node scripts/plugin-script-probe.mjs
/pi/node/tool/bin/fnm exec --using=22 -- node scripts/patch-plugin-script-node.mjs  # 幂等；升级插件后重跑
```

`--live` 构建 `pi-agent-browser:review-fixed`，使用 `piab-functional-regression` 测试容器和回环端口 9224，结束时清理测试容器。**不会替换或重启正式容器。** 设置 `PIAB_TEST_CONTAINER` 则只跑套件、不碰目标容器。独立沙箱探针只证明安装包 worker 可用；工具内 script 模式已在重启 pi 后复测通过（`/reload` 不足以清除模块缓存）。

## 正式部署与升级

以下步骤用于未来的镜像升级，会改变正式运行环境，应在明确的维护窗口执行。升级前先保留回滚 tag，例：`docker tag pi-agent-browser:0.36.0 pi-agent-browser:pre-fix-<日期>`（本次 2026-09-10 的切换已完成，回滚 tag 为 `pi-agent-browser:pre-fix-20260910`）。

```bash
cd /docker/agent-browser
/pi/node/tool/bin/fnm exec --using=22 -- npm --prefix host-adapter ci
/pi/node/tool/bin/fnm exec --using=22 -- npm --prefix host-adapter run build

# 保留回滚点。
docker tag pi-agent-browser:0.36.0 pi-agent-browser:pre-fix-$(date +%Y%m%d)
# 构建新正式镜像；此步骤本身不重启正在运行的容器。
docker compose build
# 确认可以中断现有浏览器会话后再执行。
docker compose up -d --wait

# 明确安装更新后的宿主机入口（本次已安装）。
sudo install -m 0755 wrapper/agent-browser /usr/local/bin/agent-browser
sudo install -m 0755 wrapper/agent-browser-cdp /usr/local/bin/agent-browser-cdp

docker compose ps
agent-browser doctor --quick --offline
```

首次部署时，应先准备 `data`、`profiles`、`downloads`、`screenshots`、`.cache/staging`，确保容器用户 uid/gid `1001:1001` 有适当访问权限。不要对已有业务凭证目录不加检查地递归改权限。

宿主机入口脚本已安装完毕；正式容器已于 2026-09-10 重建并运行新镜像（验证与回滚 tag 见 [docs/FUNCTIONAL_REVIEW.md](docs/FUNCTIONAL_REVIEW.md#部署状态)）。回滚：`docker tag pi-agent-browser:pre-fix-20260910 pi-agent-browser:0.36.0 && docker compose up -d --wait`。

正式 CDP 网关仅发布到 `127.0.0.1:9222`。全部持久目录采用 bind mount，不使用命名卷。只读根文件系统配合 tmpfs；当前仍保留 `SYS_ADMIN` 和 `apparmor:unconfined` 以支持现有沙箱配置，不能宣称已实现完全最小权限。

## 日常操作

```bash
cd /docker/agent-browser
docker compose ps
docker compose logs --tail=100
# 以下操作会影响活动会话，需要明确授权：
# docker compose restart
# docker compose down
```

关闭浏览器不会删除宿主机上显式请求的截图、下载、PDF 或录制。不要删除 `data/.encryption-key`，否则持久化加密状态可能无法恢复。
