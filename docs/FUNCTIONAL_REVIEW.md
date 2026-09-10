# 功能审查与回归记录

更新：2026-09-10。范围仅限 `/docker/agent-browser` 及其实际调用的 `pi-agent-browser-native`；没有修改插件安装包、业务凭证或正式容器配置。

## 修复内容

| 问题 | 当前实现 |
| --- | --- |
| 批量输入发现晚于暂存 | 先确定上游实际读取的输入，再解析、暂存、执行；有原始命令行批量行时不扫描被忽略的 stdin。 |
| 上传、元素截图、全局参数错位 | 直接调用与批量调用共用参数映射；选择器与文件分离，多文件上传逐个处理，支持没有扩展名的状态文件。 |
| 同名文件覆盖、相对路径越界 | 请求 UUID + 绝对源路径摘要；容器目标固定在该请求目录内，不用含 `..` 的相对路径拼接宿主机暂存目录。 |
| 输入文件过早删除 | 本地页面、上传文件和同批生成后再次读取的文件保留至确切会话关闭；独立会话锁与资源日志记录所有权。 |
| 取消只终止 docker 客户端 | 总截止时间覆盖准备、执行和回传。先限时关闭确切会话；若被正在执行的命令阻塞，则核对容器 PID 的 uid、可执行文件、守护进程环境、会话名和启动时间，定向终止该守护进程及捕获的子进程。其他会话不受影响。 |
| 偶发零退出码、空输出 | `setsid --wait` 等待实际浏览器命令，避免 setsid 派生后提前返回；请求 JSON 却没有有效 JSON 的结果不再判为成功。 |
| 复制失败仍成功 | 输入不存在、暂存失败、产物不存在/为空、回传失败均使调用失败。输出通过容器内 `cat` 流式写入宿主机临时文件，成功后原子重命名，不依赖 Docker archive 对挂载点的读取能力。 |
| 部分批量失败丢失已成功产物 | 按上游实际返回的成功行回传，保留原来的整体失败状态；未执行的行不假定成功。 |
| 宿主机环境路径原样传入 | 配置、状态、证书等路径按参数同样映射；socket 使用短且稳定的容器目录；明确清空所有通用代理变量。 |
| 插件误判产物丢失 | 将返回的路径元数据和批量 command 中的文件操作数映射回宿主机；不替换页面文本或页面 URL。 |
| 录制跨调用回传不完整 | 按容器、socket、命名空间、会话记录目标；支持共享及非共享目录、直接或批量 stop；上一请求的输出映射不覆盖下一请求的目标。 |
| 构建代理被 unset、安装失败被忽略 | 先保存构建代理值，安装时显式使用；去掉长安装命令链中的宽泛 `|| true`。 |
| Chrome 版本目录硬编码 | 镜像浏览器放到 `/opt/piab/browser`，不受 data 绑定挂载遮挡；回退发现按实际目录枚举并检查可执行性。 |
| 网关篡改页面 URL/标题端口、异常断连泄漏 | 只改写 CDP 发现元数据；异常关闭码不直接转发为非法 WebSocket close 帧。 |
| 插件超时后容器内守护进程仍存活 | 入口改为直接 exec fnm 受控 Node，插件 SIGTERM 直达适配器；取消清理合并为一次容器调用，并只终止本次会话的守护进程。另修复了取消路径把自己的清理子进程当成待杀对象、500ms 后误杀的问题。 |

取消不是事务回滚：已经发出的网络请求、已经提交的业务动作不能撤销。附加到外部浏览器时，不会强杀不属于该守护进程的浏览器进程。无法确认清理时返回明确警告，禁止把这种结果当作安全重试依据。

## 明确边界

- 持久 profile、默认下载目录、默认截图目录必须使用已配置的宿主机绑定挂载路径；新 profile 目录可创建。不再默默把任意宿主机 profile 当作空目录使用。
- 不搬运宿主机浏览器可执行文件或扩展目录；应在容器镜像中配置。这类输入现在明确报错。
- 非共享目录输入支持普通文件和目录递归；符号链接和特殊文件明确拒绝。
- 单次命令文本、stdin 限制 64 MiB；产物回传使用流，不把视频整体读入内存。
- 每会话最多保留 256 个请求暂存目录；达到上限时仍允许关闭会话。异常退出遗留日志保留在 `.cache/adapter-sessions` 和 `.cache/recordings`，不能在对应会话仍运行时盲删。
- 包装脚本不再因检查失败自行启动正式容器，也不回退到系统 Node。
- 本轮没有移除 `SYS_ADMIN` 或 `apparmor:unconfined`；现有配置依赖它们运行沙箱。不能把当前容器称作已经完成最小权限加固。

## 可复现测试

```bash
cd /docker/agent-browser
bash scripts/verify-functional.sh         # 构建、单元/模拟测试、语法检查
bash scripts/verify-functional.sh --live  # 另建测试镜像，启动独立容器并在结束后清理
/pi/node/tool/bin/fnm exec --using=22 -- node scripts/plugin-script-probe.mjs
```

隔离测试使用 `compose.regression.yaml`、镜像 `pi-agent-browser:review-fixed`、容器 `piab-functional-regression`。不共享正式 profiles、data 或会话，CDP 仅发布到宿主机 `127.0.0.1:9224`。测试产物位于 `.cache/live-regression`，日志位于 `.cache/functional-regression/logs`。

### 当前验证结果

- TypeScript 构建通过。
- 22 个单元/模拟测试通过；普通测试命令明确跳过 5 个真实容器测试。
- **5 个真实容器测试全部在正式容器（`pi-agent-browser`）上通过**：文件完整闭环；失败批量中的成功产物；同名文件并发隔离；收到插件 SIGTERM 后 2 秒窗口内完成取消清理并停止指定守护进程；适配器自行截止时不影响其他会话。运行方式：`PIAB_TEST_CONTAINER=pi-agent-browser bash scripts/verify-functional.sh --live`。
- 取消收敛性：套件跑完后容器内同命名空间的守护进程计数为 0，不再出现“close 尝试自行拉起新守护进程”的残留（取消脚本改为只在旧进程存活时优雅 close，并以“最终无存活进程”作为成功标准）。
- 压力（正式容器，经宿主机适配器）：同会话 100 次 `open → snapshot` **0 失败**（p50 600 ms）；4 通道并发 100 次 **0 失败**（31.5 s）；每次新建会话（含 Chrome 冷启动）20 次 **0 失败**（p50 1.66 s）。脚本：`scripts/stress-functional.mjs`。
- 调用路径优化：移除每次调用的 `docker inspect` 预检，合并目录创建与请求清理，每次调用容器往返从 6 次降到 2 次，p50 从 2.08 s 降到 0.60 s（同会话 100 次对比）。
- script 模式（工具内，重启 pi 后）：最小脚本、3 次浏览器调用、错误与策略两个负向用例全部通过，无残留守护进程。
- 网关测试 3/3 通过，含新镜像真实 HTTP 发现和 WebSocket `Browser.getVersion`。
- 原有环境隔离检查 7/7 通过。
- 新镜像构建成功，在只读根文件系统、空状态目录条件下健康启动。

### 实际 Pi 原生工具链

使用本会话真实 `agent_browser` 工具，而非只运行适配器 CLI，已验证：

1. `qa` 打开本地固定页面，断言文本/选择器，截图落盘（11 个批量步骤）。
2. `semanticAction` 填写表单；`job` 点击并断言可见结果，刷新引用。
3. stdin 批量上传、元素截图、PDF、下载、无扩展名状态保存。
4. 下一次调用读取上传文件内容，证明文件没有过早删除。
5. 原始命令字符串批量执行状态加载、页面重新验证、快照与 trace 回传。
6. 共享目录录制开始，另一次批量调用停止，宿主机产物被插件验证；容器 `ffprobe` 确认为 WebM。
7. 会话关闭后显式产物仍保留。
8. 插件层超时取消：先记录目标会话守护进程 PID，用 `timeoutMs` 触发插件看门狗，工具返回超时后该 PID 已消失，另一会话守护进程未受影响；切换命名空间复测同样通过。
9. script 模式（重启 pi 后，工具内）：最小脚本通过；3 次真实浏览器调用（open/snapshot/get text）全部成功且读到正确标题与文本；未捕获异常返回 `script-error`；被拒的 `close` 返回 `policy-blocked` 且脚本能读到拒绝信封。隔离脚本会话自动关闭，容器内守护进程/请求暂存/lease 全部归零。证据：`.cache/functional-regression/results/script-browser.json`。

本轮机器可读证据为 `.cache/functional-regression/results/final-*.json`，包括插件的产物存在性验证。截图/PDF/下载/trace 同目录，最终共享录制位于 `screenshots/functional-regression/final-shared.webm`。

### script 模式：根因与修复

**根因已定位。** 宿主 Pi 是可执行打包程序（Node SEA，`/agent-pi/bin/pi`），插件的 script 实现用 `spawn(process.execPath, ["--permission", …, script-worker.js])` 启动沙箱 worker；在 SEA 宿主下 `process.execPath` 指向 Pi 自身而不是 Node 运行时，worker 永远不会发出 `ready`，script 调用只能等到超时。

证据：

- 直接用宿主二进制跑 `--permission --max-old-space-size=64 script-worker.js …`：3 秒内无任何输出且不退出。
- 用受控 Node `v22.23.2` 跑同一命令：立即输出 `{"type":"ready"}`。
- 独立探针 `scripts/plugin-script-probe.mjs`（受控 Node、普通进程）一直通过；只有经 SEA 宿主执行时超时。

修复：`scripts/patch-plugin-script-node.mjs`（幂等）把 worker 启动改为解析真实 Node：

```
PIAB_SCRIPT_NODE（绝对路径）→ /pi/node/tool/fnm/aliases/default/bin/node
→ /usr/local/bin/node → /usr/bin/node → process.execPath（普通 Node 宿主行为不变）
```

验证（打补丁后的新进程）：

- `runAgentBrowserScript` 返回 `{patched:true, ok:true}`，最小脚本不再超时。
- 把 `PIAB_SCRIPT_NODE` 指向记录调用的包装脚本后，worker 确实经该路径启动，证明确实使用了新的解析逻辑。

生效条件与维护：

- 生效条件：**必须重启 Pi 进程**。实测在 pi 中执行 `/reload` 会重建扩展实例，但 Node 的 ESM 模块缓存仍返回旧代码：复测时进程树显示 worker 仍由 `/agent-pi/bin/pi --permission …` 启动（即修复前的 `process.execPath` 路径），script 仍超时。补丁已验证在新进程中生效；重启 pi 后即加载补丁代码。**2026-09-10 重启后工具内复测已通过**（见下）。
- 重新安装或升级 `pi-agent-browser-native` 会覆盖 `dist`，重跑 `scripts/patch-plugin-script-node.mjs` 即可；`scripts/verify-functional.sh` 已包含该调用，锚点变化时脚本会非 0 退出并要求人工确认，不会盲改。

插件的录制开始阶段还会检查宿主机 ffmpeg 并发出缺失警告；本部署实际编码在容器内，录制停止及 ffprobe 已通过。这是提示范围不匹配，不是当前录制失败。

## 部署状态

宿主机适配器已在项目目录构建；`/usr/local/bin/agent-browser` 与 `agent-browser-cdp` 已更新为本仓库的新包装脚本（直接 exec fnm 受控 Node，不再自动启动正式容器、不再回退系统 Node）。上述取消验证就是在已安装入口上完成的。

**正式容器已于 2026-09-10 10:15（Asia/Shanghai）重建并切换到新镜像** `pi-agent-browser:0.36.0`（镜像 ID `069af7f48e19`，其文件层与配置同已通过隔离测试的 `review-fixed` 镜像逐字节一致，仅构建元数据不同）。切换为重建容器，`data`、`profiles`、`downloads`、`screenshots` 均为 bind mount，持久数据未受影响。

**2026-09-10 10:47 引用对齐重建**：一次事后校验构建把 tag `pi-agent-browser:0.36.0` 重新导出为 `7bcd41b14158`，并使运行容器原先引用的镜像对象（`069af7f48e19`）被本地清理。两者文件层哈希完全相同（`74463415…`，与此前部署版本一致），属同一内容的重新导出，不是代码差异。为让运行引用与本地 tag 一致，已用 `docker compose up -d --force-recreate` 重建容器，现运行镜像即 `7bcd41b14158`。重建后验证：容器 `healthy`、CDP 正常（Chrome 153）、`agent-browser doctor --quick --offline` 8 pass / 0 warn / 0 fail、Chrome 进程 `--no-sandbox` 计数 0、持久数据完好、真实插件链路 open / get text / close 通过、守护进程与请求暂存归零。同一内容另有独立验证：完整真实容器套件（含录制、下载、PDF、trace、并发、两种取消）与压力测试均在正式容器上以 0 失败通过。

回滚 tag 已保留：`pi-agent-browser:pre-fix-20260910`（`14c11543ba61`，即切换前的运行镜像）。如需回滚：

```bash
docker tag pi-agent-browser:pre-fix-20260910 pi-agent-browser:0.36.0
docker compose -f /docker/agent-browser/compose.yaml up -d --wait
```

### 切换后验证（全部在正式容器上完成）

- 容器 `healthy`，运行镜像与 tag 均指向新镜像。
- CDP 网关：`curl http://127.0.0.1:9222/json/version` 返回 Chrome 153 与可达的 `webSocketDebuggerUrl`。
- 容器内 `agent-browser doctor --quick --offline`：8 pass / 0 warn / 0 fail。
- 浏览器为镜像内 `/opt/piab/browser/chrome` 包装脚本；全部 Chrome 进程均无 `--no-sandbox`（排查确认之前的计数是 `ps`/`grep` 伪影）。
- 持久数据完好（`data` 中的 namespaces、auth vault 等均在）。
- 真实插件链路：上传、快照、元素截图、状态保存均成功，产物经插件在宿主机验证为有效 PNG；会话关闭后请求暂存目录清零。
