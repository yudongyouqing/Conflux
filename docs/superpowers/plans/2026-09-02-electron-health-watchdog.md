# Electron UI 健康探活实现计划

> **面向 AI 代理的工作者：** 使用 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框跟踪进度。

**目标：** 为 Electron 增加独立的 Renderer/Main ping-pong watchdog 和本地服务健康监控，不改变 MCP 会话租约语义。

**基线：** `feature/conflux-productization`（已包含 MCP lease 实现）。

**分支：** `feature/electron-health-watchdog`。

## 文件清单

- 创建：`apps/desktop/src/renderer-watchdog.cjs` — Renderer ping/pong 状态机。
- 创建：`apps/desktop/src/service-health.cjs` — 服务健康检查状态机。
- 修改：`apps/desktop/src/preload.cjs` — 私有 ping listener 和 pong 回传。
- 修改：`apps/desktop/src/main.cjs` — watchdog、BrowserWindow 事件、子进程和健康监控接入。
- 创建：`apps/desktop/test/renderer-watchdog.test.cjs` — watchdog 单元测试。
- 创建：`apps/desktop/test/service-health.test.cjs` — 服务健康单元测试。
- 创建：`apps/desktop/test/main-wiring.test.cjs` — Main/Preload 接线回归测试。
- 修改：`docs/TROUBLESHOOTING.md` — 记录桌面壳健康和 Agent 会话在线的边界。

不修改数据库、`packages/shared`、MCP 工具、HTTP 路径和 Agent-specific 探测器。

### 任务 1：实现 Renderer watchdog 状态机

**文件：**

- 创建：`apps/desktop/test/renderer-watchdog.test.cjs`
- 创建：`apps/desktop/src/renderer-watchdog.cjs`

- [ ] **步骤 1：先编写失败测试**

覆盖以下行为：

- `start()` 立即发送第一个 nonce ping。
- 合法 pong 把状态从 `starting` 变为 `responsive`。
- 超过 30 秒没有 pong 变为 `unknown`。
- unknown 状态收到合法 pong 后恢复 responsive。
- `unresponsive` 只进入 unknown，`render-process-gone` 进入 crashed。
- `stop()` 清除定时器并忽略后续 pong。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test apps/desktop/test/renderer-watchdog.test.cjs`

预期：因 `renderer-watchdog.cjs` 尚不存在而失败，不应出现测试装载拼写错误。

- [ ] **步骤 3：实现最小状态机**

实现 `createRendererWatchdog(options)`：

```js
{
  intervalMs = 10_000,
  timeoutMs = 30_000,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  sendPing,
  onStateChange,
}
```

返回 `start()`、`stop()`、`handlePong(payload)`、`markUnresponsive()`、`markResponsive()`、`markCrashed(details)`、`tick()` 和 `snapshot()`。状态机不依赖 Electron。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test apps/desktop/test/renderer-watchdog.test.cjs`

预期：所有 watchdog 测试通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer-watchdog.cjs apps/desktop/test/renderer-watchdog.test.cjs
git commit -m "feat: add renderer health watchdog"
```

### 任务 2：实现本地服务健康监控

**文件：**

- 创建：`apps/desktop/test/service-health.test.cjs`
- 创建：`apps/desktop/src/service-health.cjs`

- [ ] **步骤 1：先编写失败测试**

使用 fake probe 和 fake timer，验证：健康状态、单次失败为 degraded、连续两次失败为 unhealthy、恢复为 healthy、probe 未结束时不重入、stop 后不再调度。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test apps/desktop/test/service-health.test.cjs`

预期：因模块尚不存在而失败。

- [ ] **步骤 3：实现状态机和 HTTP probe**

实现 `createServiceHealthMonitor({ name, probe, intervalMs = 15_000, failureThreshold = 2, ... })`，将 probe 异常视为失败，保证同一时间只有一次 probe。导出 `probeHttp(url, timeoutMs = 2_000)`，只有 HTTP 状态码 `200-399` 视为成功；请求错误、超时和其他状态码视为失败。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test apps/desktop/test/service-health.test.cjs`

预期：所有服务健康测试通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/service-health.cjs apps/desktop/test/service-health.test.cjs
git commit -m "feat: monitor desktop service health"
```

### 任务 3：接入 Preload 和 BrowserWindow watchdog

**文件：**

- 修改：`apps/desktop/src/preload.cjs`
- 修改：`apps/desktop/src/main.cjs`
- 创建：`apps/desktop/test/main-wiring.test.cjs`

- [ ] **步骤 1：先增加接线失败测试**

静态检查固定 IPC channel、Preload `on/send` 配对、Main 校验 `event.sender === mainWindow.webContents`、`unresponsive`、`responsive`、`render-process-gone` 监听，以及 close/quit 清理。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test apps/desktop/test/main-wiring.test.cjs`

预期：当前源码缺少 ping/pong 和 Renderer 事件接线，断言失败。

- [ ] **步骤 3：实现 Preload 私有 pong**

在 Preload 中监听 `conflux:renderer-ping`，只接受带正整数 nonce 的 payload，并发送 `{ nonce }` 到 `conflux:renderer-pong`。不把 IPC sender 暴露给页面，保持 `contextIsolation: true` 和 `nodeIntegration: false`。

- [ ] **步骤 4：实现 Main 接线和 Renderer 故障处理**

在 Main 中保存当前 watchdog：

- `ipcMain.on` 只接受当前 BrowserWindow 的 sender 和合法 payload。
- `createWindow` 后启动 watchdog，ping 通过 `webContents.send` 发给 Preload。
- 监听 `unresponsive`/`responsive`，将 `render-process-gone` 标记为 crashed。
- Renderer 崩溃时只处理一次：写 stderr、显示错误对话框并退出；正常 `before-quit`/`closed` 停止 watchdog。
- 不触碰 MCP 数据库和会话状态。

- [ ] **步骤 5：运行桌面回归测试确认通过**

运行：`node --test apps/desktop/test/*.test.cjs`

预期：原有桌面测试和接线测试全部通过。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/main.cjs apps/desktop/src/preload.cjs apps/desktop/test/main-wiring.test.cjs
git commit -m "feat: wire Electron renderer watchdog"
```

### 任务 4：接入服务进程和 HTTP 健康监控

**文件：**

- 修改：`apps/desktop/src/main.cjs`
- 修改：`apps/desktop/src/dev-services.cjs`
- 修改：`apps/desktop/src/production-services.cjs`
- 创建或修改：`apps/desktop/test/production-services.test.cjs`
- 创建或修改：`apps/desktop/test/dev-services.test.cjs`

- [ ] **步骤 1：增加运行时故障回归测试**

使用可注入的状态回调验证：启动阶段服务退出仍由原有 `waitForService` 处理；运行阶段意外退出只处理一次；主动退出不弹故障；连续两次健康失败触发一次故障，恢复不会退出。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/production-services.test.cjs`

预期：当前没有运行期健康监控和故障回调，新增断言失败。

- [ ] **步骤 3：实现服务监控接入**

- `recordChild` 增加运行期退出回调，但以 `isQuitting` 和 `servicesReady` 区分主动退出/启动失败。
- server/web 服务 ready 后启动 `createServiceHealthMonitor`；monitor stop 函数加入统一清理。
- 连续两次 unhealthy 或运行期 child exit 调用同一个幂等 `failRuntime()`，显示服务名/原因并退出。
- 生产 server 沿用 `/healthz`，开发 server/web 沿用已有 spec URL。

- [ ] **步骤 4：运行测试确认通过**

运行：`npm run test:desktop`

预期：桌面测试全部通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main.cjs apps/desktop/src/dev-services.cjs apps/desktop/src/production-services.cjs apps/desktop/test
git commit -m "feat: guard Electron service health"
```

### 任务 5：补充文档和全量验证

**文件：**

- 修改：`docs/TROUBLESHOOTING.md`
- 检查：所有桌面/服务端测试和构建

- [ ] **步骤 1：补充状态边界文档**

说明：Electron UI watchdog 的 `responsive/unknown/crashed` 只表示桌面壳状态；MCP `connected` 才表示 MCP 连接存活；PID/窗口聚焦只用于辅助和 Resume。

- [ ] **步骤 2：检查文档格式**

运行：`git diff --check -- docs/TROUBLESHOOTING.md`

- [ ] **步骤 3：运行全量测试**

运行：`npm test -w apps/server`、`npm run test:desktop`、`node --test scripts/release-config.test.cjs`

- [ ] **步骤 4：运行源码构建**

运行：`npm run build`

说明：`npm run build:desktop` 需要 Electron native rebuild；如果本机缺少 Visual Studio C++ 工具链，只记录环境阻塞，不把失败归因于 watchdog 源码。

- [ ] **步骤 5：手动启动验证**

停止其他工作树的 9527/5173 实例，从当前分支运行 `npm run dev:desktop`，确认窗口加载、Renderer pong 日志/状态、服务端健康检查和关闭清理。不得复用其他工作树的 server/MCP 进程。

- [ ] **步骤 6：检查工作树并提交进度**

运行：`git diff --check`、`git status --short --branch`、`git log --oneline -8`。

预期：只有本计划列出的文件变更；工作树干净后再推送功能分支。

## 规格覆盖检查

| 规格要求 | 对应任务 |
| --- | --- |
| Main/Preload ping-pong | 任务 1、任务 3 |
| Renderer unknown/responsive/crashed 状态 | 任务 1、任务 3 |
| sender 校验和 IPC 安全边界 | 任务 3 |
| BrowserWindow 无响应/崩溃监控 | 任务 3 |
| server/web 退出和健康监控 | 任务 2、任务 4 |
| 不改变 MCP 会话在线语义 | 任务 3、任务 5 |
| 文档、测试和当前分支手动验收 | 任务 5 |

