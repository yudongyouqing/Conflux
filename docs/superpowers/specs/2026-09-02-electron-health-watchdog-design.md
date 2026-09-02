# Electron UI 健康探活设计

**日期：** 2026-09-02

**状态：** 方向已确认，准备实现

**范围：** Electron 桌面壳的 Renderer、Main 和本地服务健康状态

## 1. 问题与目标

当前 Electron Main 进程只持有 `BrowserWindow` 引用，并处理窗口加载、单实例聚焦和子进程退出日志，没有可靠的 Renderer 响应探测。另一方面，MCP 会话在线状态已经由连接租约负责；不能用 Electron UI 是否响应来替代 Codex/Claude 会话在线判定。

本次目标：

1. 为 Electron 增加独立的 Main ↔ Renderer ping/pong watchdog。
2. 能区分 Renderer 正常响应、超时未知、Renderer 崩溃和已停止。
3. 监听 `unresponsive`、`responsive`、`render-process-gone`，避免桌面壳显示一个已经失效的页面。
4. 监控 Electron 自己启动的 server/web 子进程和 HTTP 健康端点；运行中服务异常时明确结束桌面实例，不修改任何 Agent 会话状态。
5. 保持现有单实例、托盘隐藏、开发/生产启动和安全导航行为不变。

## 2. 状态边界

桌面壳健康状态只描述 Electron UI 和它拥有的本地服务：

```text
starting -> responsive -> unknown -> responsive
                   \-> crashed
                   \-> stopped
```

- `responsive`：最近一次 Main 发出的 ping 在超时窗口内收到合法 pong。
- `unknown`：超过超时窗口没有收到 pong，或 Electron 报告 Renderer 无响应；不直接称为 crashed。
- `crashed`：`render-process-gone` 明确报告 Renderer 进程结束。
- `stopped`：watchdog 在窗口关闭或应用退出时停止。

这些状态不写入 `sessions.status`，也不影响 MCP lease、PID reconcile、Hook 或 Resume 路由。MCP 会话仍以 MCP 连接租约为在线依据。

## 3. Renderer ping/pong

### 3.1 消息方向

Main 每 10 秒通过私有 IPC channel `conflux:renderer-ping` 发送递增 nonce 和发送时间。Preload 收到后立即通过 `conflux:renderer-pong` 回传 nonce。Renderer 页面无需修改，也不会获得额外 Node 能力。

Main 只接受来自当前 `mainWindow.webContents` 的 pong，并校验 nonce 为正整数；其他 WebContents 或畸形 payload 静默丢弃。这样不会把外部窗口或伪造 IPC 消息计为健康。

### 3.2 超时和恢复

- ping 间隔：10 秒。
- watchdog 超时：30 秒。
- 首次 ping 在 watchdog 启动时立即发送。
- 超时后进入 `unknown` 并记录一次告警；后续收到合法 pong 恢复为 `responsive`。
- 不因一次超时自动 reload，避免隐藏窗口、系统调度或短暂事件循环阻塞造成破坏性恢复。

### 3.3 Electron 事件

- `did-finish-load`：保留启动日志，watchdog 继续正常工作。
- `unresponsive`：进入 `unknown` 并记录原因。
- `responsive`：收到事件后恢复为 `responsive`。
- `render-process-gone`：进入 `crashed`，记录 reason/exitCode；由 Main 统一结束应用并提示用户重新启动，防止继续展示失效 UI。
- `closed`、`before-quit`：停止定时器并解除 pong 接收引用。

## 4. 本地服务健康

Main 已经在启动阶段等待服务健康端点。本次增加运行中监控：

- 每个 Electron 所有的服务使用已有 spec URL 进行探测；server 使用 `/healthz`，web 使用本地根路径。
- 探测间隔 15 秒，连续 2 次失败才进入 `unhealthy`，单次失败只进入 `degraded`。
- 探测恢复进入 `healthy` 并记录恢复日志。
- `unhealthy` 或子进程意外退出时，Main 只处理一次错误：记录服务名和原因，显示错误对话框并退出桌面实例。
- 应用主动退出、启动阶段失败和 taskkill 触发的退出不当作运行时故障。

健康监控只负责桌面实例自己的依赖，不调用数据库 liveness API，不回收 MCP 会话。

## 5. 文件边界

- `apps/desktop/src/renderer-watchdog.cjs`：可注入时钟/定时器的纯 watchdog 状态机。
- `apps/desktop/src/service-health.cjs`：可注入 probe/定时器的服务健康状态机。
- `apps/desktop/src/preload.cjs`：私有 ping listener 和 pong sender。
- `apps/desktop/src/main.cjs`：IPC sender 校验、BrowserWindow 事件、子进程故障和健康监控接入。
- `apps/desktop/test/renderer-watchdog.test.cjs`：状态转换、超时、恢复和停止测试。
- `apps/desktop/test/service-health.test.cjs`：连续失败阈值、恢复、并发 probe 和停止测试。
- `apps/desktop/test/main-wiring.test.cjs`：静态检查 IPC channel、事件监听和清理路径。
- `docs/TROUBLESHOOTING.md`：说明桌面壳健康和 Agent 会话在线的区别。

不修改 `packages/shared`、数据库 schema、MCP 工具、HTTP 路径或 Agent-specific 文件/SQLite 探测器。

## 6. 验收标准

1. watchdog 启动立即发送 ping，合法 pong 将状态置为 `responsive`。
2. 30 秒没有合法 pong 时只变为 `unknown`，收到后续 pong 可恢复。
3. `unresponsive` 不会直接标记 `crashed`；`render-process-gone` 才进入 `crashed`。
4. 非当前 BrowserWindow sender 和畸形 pong 不会刷新健康时间。
5. Electron 启动的 server/web 任一连续两次健康检查失败时只结束桌面实例一次；一次失败或恢复不会误退出。
6. 应用正常退出不会弹出运行时故障对话框，也不会遗留定时器。
7. MCP lease 的 `active/stale` 逻辑和既有桌面启动行为回归测试保持通过。

