# 受管 Codex 执行端（Managed Codex Executor）

Conflux 可以不打开终端窗口，而是由服务端直接持有一个 Codex `app-server`
子进程，通过 stdio JSON-RPC 完成创建会话、排队任务、展示进展、人工审批、
中断与崩溃恢复。这是编码助手预设的一种**执行模式**（opt-in），与原有的
终端启动模式并存，互不影响。

## 支持的 CLI 版本

- **codex-cli 0.164.0**（首期实测版本；协议按该版本锁定）。
  初始化握手时会读取服务端 `userAgent` 中的版本号，不兼容版本会被拒绝。
- 实测平台：**Windows 11**（主开发机）。macOS / Linux 未实测，进程解析
  （PATH 查找、shim 展开）按 POSIX 直通逻辑实现，使用前请先冒烟验证。
- 可执行文件解析：支持真实 exe、`node <script>` 直接调用、以及 npm 的
  `.cmd` shim（展开为 `node <包入口脚本>`，绝不经 shell 执行）。

## 与外部接入会话的差异

| | 终端模式（外部接入） | 受管模式 |
| --- | --- | --- |
| 进程宿主 | 用户终端窗口 | Conflux 服务端子进程 |
| 提示投递 | send-keys / stdin 唤醒 | `turn/start`（按本地顺序排队，不 steer） |
| 审批 | 终端里人工点击 | 网页受管面板，仅人工（web console）可决 |
| 消息闭环 | 会话自行 reply | 终态由 core 恰好一次回写原消息 |
| 崩溃语义 | 取决于终端会话 | 见下文“unknown 与恢复” |

外部接入的会话**不会**因为被选中或收到消息而自动转为受管；一个 thread
也不能同时被两个宿主持有——恢复时若检测到旧进程仍存活会明确拒绝。

## 使用

1. 助手页 → 创建编码助手 → 运行时选 **Codex** → 勾选 **Conflux 受管执行**。
2. 「启动（受管）」后实例先以 starting 记录，只有拿到**真实 thread id**
   （协议返回）才转为 running。
3. 展开预设卡片 → 「打开受管执行面板」：
   - 顶部为当前执行状态（空闲 / 执行中 / 等待审批 / 排队 N 项）；
   - 审批卡提供**本次允许 / 拒绝 / 取消**，不含会话级或策略级放行；
   - 「中断任务」与「停止实例」是两个动作：中断只作用于当前 turn 并保留
     interrupted 终态，停止才会终止子进程；
   - 任务输入走现有问答通道，收件人固定为该受管会话。
4. 执行进展（文本 / 工具 / 状态）按事件序号增量显示，可通过
   `GET /runtime-instances/:id/managed/events?stream=1` 以 SSE 订阅，
   重连用 `after=<sequence>` 续读，序号去重。

## 状态与幂等

- 每条消息至多对应一个逻辑执行（`managed_codex_runs.message_id` 唯一）；
  重复投递、服务重启都不会二次发送 `turn/start`。
- 终态：`completed` / `failed` / `interrupted`（终态冻结，迟到通知不能改写）。
- **unknown**：发送窗口不可核实（发出但未收到确认、断线、崩溃）的任务进入
  unknown，UI 明确显示“执行状态待核对”。恢复时用保存的 thread id 调
  `thread/resume` 并核对历史：找到确定的完成/失败/中断证据才补终态与回写；
  没有证据（含发出前崩溃的任务）保留 unknown，由用户人工核对后再决定重发。
  首期不做自动 exactly-once 声明。
- 审批随接收它的连接代际失效：子进程死亡或服务重启后，未决审批转为
  expired，不再显示为可回应。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/runtime-instances/:id/managed` | binding、当前 run、队列、待审批 |
| GET | `/runtime-instances/:id/managed/events?after=N&stream=1` | 事件回放 / SSE |
| POST | `/runtime-instances/:id/managed/interrupt` | `{ expected_turn_id? }` |
| POST | `/runtime-instances/:id/managed/approvals/:approvalId` | `{ decision: accept\|decline\|cancel }`，仅 web console 身份 |

HTTP / CLI / MCP 共用同一 core；不存在能绕过审批的 Agent 工具。

## 已知限制（首期）

- 仅 `runtime === "codex"` 支持受管；Claude SDK 为后续单独计划。
- 一个受管实例独占一个根 thread；并发任务排队，不做 steer。
- 审批仅支持 item 系 `commandExecution` / `fileChange` 两类；旧版审批方法
  与其他服务端请求一律明确拒绝，绝不默认批准。
- 真实模型调用（turn 执行）需要有效的 Codex 登录凭据；无凭据时 initialize
  与 thread 创建仍可完成，但 turn 会以认证错误失败。
- 受管实例在 liveness 刷新下可能显示 stale（其子进程由服务端持有，不走
  外部会话的身份令牌链路）；面板数据以 `/managed` 端点为准。
