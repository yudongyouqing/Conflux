# 消息重试与受管运行实例

## 消息为何仍是 pending

消息先存入 Conflux，再按设置尝试唤醒收件人。消息的 `pending / seen / replied / read` 表达阅读和回复进度，独立的唤醒记录表达尝试结果：

| 唤醒结果 | 含义 |
| --- | --- |
| 待投递（queued） | 已存储；可能关闭了自动唤醒、对端正忙、已有唤醒在途或达到并发上限。 |
| 已尝试唤醒（woken） | 已发起唤醒或输入通知；不等于对端已阅读或必定会回复。 |
| 唤醒失败（failed） | 启动失败或运行时无法按当前条件恢复。原因可在消息中查看。 |

网页消息流和线程中的“重试唤醒”复用原消息，不会复制一条问题。只有仍为 pending 的消息可重试；调用者必须是发送方、当前接收方或人工控制台。并发尝试互斥，继续遵循自动唤醒开关、忙碌判断、去重和并发限制。导入或历史消息没有尝试记录时，不会被当成失败。

如果找不到目标会话，先使用[会话候选确认](SESSION-DIRECTORY.md)。Ghostty 等终端标题可能改变；确认完整会话 ID 后再发送，不能向猜测的目标试发消息。

## 预设与运行实例

运行时预设保存 CLI、项目目录、模型与连接配置，可以重复使用。受管运行实例代表从预设启动的一次运行，单独显示状态、会话和 PID；现有任意外部终端不会自动成为可停止的实例。

实例启动后等待真实 CLI 的 hooks 或 MCP 连接建立绑定。终端窗口启动器 PID 不作为 CLI PID。尚未绑定时显示限制，停止按钮不可用；“starting”不证明模型已经完成连接。

交互式新终端启动沿用现有 Windows/macOS 支持；Linux 的交互式终端适配不在本批。Codex 必须具有可确定的原始 thread ID 才能恢复；同项目并发启动导致匹配歧义时不猜测。

停止会终止该实例中经过核验的 CLI 进程，因此未保存的当前工作可能中断。每次停止前重新验证会话绑定、运行时类型、PID 及进程创建标识；无法验证或 PID 被其他进程复用时拒绝停止。列表上显示可以停止，也不能绕过执行时的重新验证。

恢复会创建一个新实例，并恢复原对话、目录及启动配置。原进程仍在运行、无法确认其退出、已有恢复实例、缺少可恢复对话，或原预设已删除/连接配置改变时，恢复不可用。此时按界面原因处理，必要时从预设重新启动。实例快照不另存 API 密钥；连接配置由原预设提供。

## 使用和验证边界

| 接口 | 操作 |
| --- | --- |
| CLI | `conflux msg retry <id>`、`conflux runtime instances`、`conflux runtime stop <id>`、`conflux runtime resume <id>`；沿用全局会话身份和 `--http` 选项。 |
| MCP | `retry_message_delivery`、`list_runtime_instances`、`stop_runtime_instance`、`resume_runtime_instance`。 |
| HTTP | `POST /messages/:id/retry`（`X-Session-Id`），`GET /runtime-instances`，`POST /runtime-instances/:id/stop`、`POST /runtime-instances/:id/resume`。 |

网页在原运行时预设下显示受管实例；状态和错误均带文字，颜色只辅助区分。浅色与深色沿用同一语义：成功、警告、危险、信息、中性。自定义主题仍接受原有八个颜色字段。

HTTP 继续使用现有本地服务及会话身份边界；MCP 和 CLI 复用同一 core 规则。自动测试使用隔离数据库与注入的进程适配器验证安全边界，不会启动或终止用户的真实外部会话。实际 Codex/Claude Code 宿主启动、退出和跨平台终端行为仍需分别记录实测。

浏览器截图：[浅色设置](assets/screenshots/collaboration-controls/theme-light-desktop.png)、[深色设置](assets/screenshots/collaboration-controls/theme-dark-desktop.png)、[窄屏设置](assets/screenshots/collaboration-controls/theme-dark-narrow.png)、[深色图谱](assets/screenshots/collaboration-controls/theme-dark-graph.png)、[消息重试](assets/screenshots/collaboration-controls/message-retry-desktop.png)、[窄屏实例](assets/screenshots/collaboration-controls/runtime-instances-narrow.png)。截图来自 `npm run test:e2e:web` 的隔离数据；实例由 fixture 创建，不代表真实外部进程启动验收。
