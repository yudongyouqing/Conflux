# 受管 Codex 执行端实现计划（交给 GLM）

> **面向 AI 代理的工作者：** 使用 `superpowers:executing-plans` 在独立工作区逐任务执行，使用下方复选框跟踪进度。用户指定由 GLM 执行；本计划不另行要求派生子 Agent。

**目标：** 在保留外部会话接入的前提下，通过 Conflux 持有的 Codex app-server 完成创建会话、定向任务、进展与审批、中断、原对话恢复这一条闭环。

**架构：** 保留 SQLite 与现有 core 作为消息事实来源。增加 opt-in 的受管执行模式，由服务端持有 app-server 的 stdio JSON-RPC 连接；每个首期受管实例独占一个 app-server 进程和一个根 thread。任务调度、协议传输、运行事件与网页展示分别负责各自状态；外部终端继续沿用原路径。

**技术栈：** TypeScript、Node.js child_process/streams、better-sqlite3、Fastify、React、Node test runner + tsx、Codex app-server。

---

## 0. 已确认方向与执行边界

用户已选择：两者兼顾，先做受管执行端。首期只实现受管 Codex；Claude SDK 作为后续单独计划。现有模型助手、外部 Claude/Codex 会话、终端启动模式、聊天室保持兼容。

本计划交接的是实现任务，不包含扩大权限、自动批准执行、修改生产数据或发布版本的授权。审批由用户明确处理，其他 Agent 的消息不代表用户授权。

### 已核对的代码基线

- 2026-11-12 检查时，主 checkout 为本地 dev `85791cf`；fetch 后 origin/dev 为 `d9b5dfb`。执行前重新 fetch，以最新 dev 为基线，禁止在旧 checkout 上整套实现。
- Codex 源码：`C:/Users/yudongyouqing/code/codex`，本轮读取提交 `5c3ff1dabf644169f4bd74b215719f381e4fdb3f`。本地实际安装 CLI 版本可能不同，执行时记录实际版本与该版本生成的协议 schema。
- `apps/server/src/core/ask.ts` 已实现数据库准备 / 外部唤醒分离，以及一次性 claim 和原消息重试。复用此原则，不重建第二套消息总线。
- `apps/server/src/core/messages.ts` 的 pending/seen/replied/read 与 message_deliveries 的 queued/woken/failed 已分离。新执行状态单独保存，不能把 woken 当成任务成功。
- `apps/server/src/core/wake/codex.ts` 当前在线空闲会采用摘要注入的新运行。受管模式通过自己的连接工作，禁止走摘要代答 fallback；外部会话仍保留原行为。
- origin/dev 已有聊天优先工作区：`apps/web/src/components/AssistantsTab.tsx`、`RuntimeInstancesPanel.tsx`、`WorkspaceTab.tsx`。不要依据旧 checkout 的页面结构新增平行界面。

### 官方协议与源码依据

- 官方 app-server 文档：https://learn.chatgpt.com/docs/app-server
- 本地协议定义：`C:/Users/yudongyouqing/code/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`、`turn.rs`。
- 本地 Agent 投递链：`codex-rs/core/src/agent/control.rs`、`session/handlers.rs`、`session/input_queue.rs`。
- app-server 中使用公开 thread/turn RPC；不把 Codex 内部 collaboration 工具当成可跨任意进程调用的接口。

## 1. 首期可观察行为

1. 在现有助手入口选择 Codex 的“Conflux 受管”模式后，Conflux 启动 app-server，完成 initialize / initialized，再创建根 thread。
2. 启动成功必须获得真实 thread ID；进程 spawn 成功只能表示 starting。
3. 向该会话发送任务后先落库，再调度。空闲时启动 turn；忙碌时后续任务按本地顺序排队，默认不 steer 当前工作。
4. 用户能看到文本进展、工具执行、等待审批、失败原因和最终结果。审批不自动同意。
5. 用户可中断当前 turn；“中断任务”与已有“停止实例”是两个不同动作。中断后的任务保留 interrupted 结果，不被标成完成。
6. 受管会话继续参与现有跨会话问答：完成结果由 core 以原 message ID 写回一次；后续处理同一消息不重复启动执行。
7. 重启或掉线后核对保存的 thread/turn，再恢复原对话。未发送任务可以继续排队；可能已经执行但尚未收到确认的任务进入 unknown，先核对历史，不能盲目重放。
8. 外部接入会话不会因为被选中或收消息而自动成为受管实例，也不能通过新 app-server 接管已被其他宿主持有的 thread。

## 2. 明确接口和状态

### 启动模式

在 RuntimeAgent 增加 `execution_mode: "terminal" | "managed"`，旧数据默认 terminal。首期只有 `runtime === "codex"` 可选择 managed；其他组合返回清晰的 400 错误。RuntimeInstance 保存启动时的模式快照，不能因预设后来被编辑而改变实例含义。

实例生命周期继续使用现有 starting/running/ended/stale/failed；turn 的 idle/running/waiting_approval/interrupted/completed/failed/unknown 使用独立字段或对象，不能扩散修改原实例生命周期含义。

### 受管执行契约

新增 `apps/server/src/core/managed-codex/types.ts`：

```ts
export type ManagedRunState =
  | "queued" | "submitting" | "running" | "waiting_approval"
  | "completed" | "failed" | "interrupted" | "unknown";

export interface ManagedCodexBinding {
  instanceId: string;
  sessionId: string;
  threadId: string;
}

export interface ManagedTaskInput {
  messageId: number;
  instanceId: string;
  text: string;
}

export interface ManagedCodexEvent {
  sequence: number;
  instanceId: string;
  runId: string | null;
  threadId: string | null;
  turnId: string | null;
  type: "text" | "tool" | "approval" | "status" | "error";
  payload: Record<string, unknown>;
}
```

上面是 Conflux 自有契约，不替代 Codex 官方 RPC schema。审批参数及决策必须使用实际 CLI 版本的协议类型进行校验；不能把任意字符串直接转发给 child。

### 持久化

沿用现有 db.ts 的 ensureColumn / user_version 迁移方式。建议拆为：

- `managed_codex_bindings`：instance_id 主键、session_id、thread_id、active_turn_id、owner_token、updated_at。外部会话不得通过此表伪造所有权。
- `managed_codex_runs`：id、message_id UNIQUE、instance_id、thread_id、turn_id、state、request_id、final_text、error_code、created_at、updated_at。同一 message_id 在任何恢复实例中最多对应一个逻辑执行，恢复需要显式更新归属与状态。
- `managed_codex_events`：sequence INTEGER PRIMARY KEY、instance_id、run_id、type、payload、created_at。保存可重放的归一化事件；不保存原始 reasoning、凭据或完整环境。
- `managed_codex_approvals`：id、run_id、rpc_request_id、request_kind、payload、state、created_at、resolved_at。重启时原进程不再可达的审批变 expired，不能显示为仍能响应。

事务内只改变数据库状态；spawn、stdin.write、RPC 等副作用均在提交后执行。对发送后崩溃的窗口用 unknown + reconcile 表达，不承诺跨进程副作用 exactly-once。

## 3. 文件职责

| 文件 | 变更与职责 |
| --- | --- |
| `packages/shared/src/index.ts` | 对外启动模式、受管执行摘要、事件和审批响应类型 |
| `apps/server/src/core/db.ts` | 增量 schema 与旧数据迁移 |
| `apps/server/src/core/managed-codex/types.ts` | 内部输入和归一化事件契约 |
| `apps/server/src/core/managed-codex/rpc.ts` | JSONL 分帧、请求关联、超时、服务端请求与断线 |
| `apps/server/src/core/managed-codex/process.ts` | 可执行文件解析、stdio 子进程、退出与清理 |
| `apps/server/src/core/managed-codex/store.ts` | 受管绑定、任务、事件、审批的数据库操作 |
| `apps/server/src/core/managed-codex/manager.ts` | 实例连接、thread/turn 生命周期、串行任务调度与恢复核对 |
| `apps/server/src/core/managed-codex/events.ts` | 官方通知归一化、终态与最终文本归并 |
| `apps/server/src/core/managed-codex/approvals.ts` | 待处理请求关联、用户响应、失效处理 |
| `apps/server/src/core/runtime-agents.ts`、`runtime-instances.ts` | 模式分流与已有实例生命周期衔接 |
| `apps/server/src/core/ask.ts`、`mail-push.ts` | 受管目标分流，消息结果回写；不触发旧终端输入或摘要唤醒 |
| `apps/server/src/http/routes/managed-codex.ts` | 事件、审批、中断 HTTP 契约 |
| `apps/server/src/http/routes/runtimes.ts`、`http/server.ts` | 启动模式、路由注册、服务关闭清理 |
| `apps/web/src/api.ts` | 类型化接口与事件订阅 |
| `apps/web/src/components/RuntimeInstancesPanel.tsx`、`AssistantsTab.tsx` | 模式、受管会话入口和实例状态 |
| `apps/web/src/components/ManagedCodexPanel.tsx` | 任务进展、审批、中断与恢复结果 |
| `apps/server/src/test/managed-codex-*.test.ts` | 对应行为回归 |
| `apps/server/src/test/managed-codex-process.e2e.ts` | 真实 Node 子进程协议与生命周期验证 |
| `apps/server/src/test/managed-codex-shim.cjs` | 可控假 app-server；不调用真实模型 |
| `apps/web/test/managed-codex.test.ts` | 状态、流式显示和用户操作回归 |
| `docs/MANAGED-CODEX.md` | 使用说明、支持版本、验收与限制 |

如最新 dev 的模块入口变化，只调整接入文件位置，不复制已有能力。

## 4. 实施步骤

### 任务 1：准备隔离工作区，锁定协议

- [x] 用 gh 搜索已有 managed Codex / app-server 相关 issue；有匹配则复用，没有则创建一个范围与本计划一致的功能 issue。
- [x] `git fetch origin dev`，从最新 origin/dev 创建 `feat/<issue>-managed-codex`，worktree 位于 `.worktrees/feat/<issue>-managed-codex`。保留当前 checkout 与其他 worktree 的未提交内容。
- [x] 阅读工作区 AGENTS.md、CLAUDE.md 和现有协作控制测试；安装依赖并记录 server/web/build 基线结果。
- [x] 在隔离配置下记录实际 Codex CLI 版本，执行 `codex app-server generate-ts --out <temporary-protocol-dir>`，核对 initialize、thread/start/resume/read、turn/start/interrupt、通知和审批字段；开发期固定所支持的版本，遇到不兼容版本明确拒绝。
- [x] 保存协议测试 fixture，覆盖 JSON-RPC 响应、通知、审批请求和失败终态。fixture 仅含合成文本，不拷贝用户会话。

### 任务 2：数据库与任务幂等

**测试文件：** `apps/server/src/test/managed-codex-store.test.ts`。

- [x] 先写失败测试：升级保留旧消息/预设；默认 terminal；同一 message_id 重复 enqueue 返回同一 run；两个并发调度者只能一个从 queued 领取为 submitting；expired owner 不得完成新 owner 的任务。
- [x] 实现 types.ts、store.ts 与 db.ts 迁移；默认值兼容旧版本；为 message_id 创建唯一约束。
- [x] 为纯状态迁移实现按前态与 owner token 条件更新，失败返回 conflict，不重复执行外部副作用。
- [x] 用下列契约断言作为最小回归形状；setup 使用临时 DB，insertMessage 是测试 fixture 中实际插入 sender/recipient/message 的帮助函数：

```ts
const first = enqueueManagedTask(db, input);
const second = enqueueManagedTask(db, input);
assert.equal(first.id, second.id);
const count = db.prepare("SELECT COUNT(*) AS n FROM managed_codex_runs").get() as { n: number };
assert.equal(count.n, 1);
```

`enqueueManagedTask(db, input: ManagedTaskInput)` 在 store.ts 中实现，返回持久化 run；不要直接调用 RPC。

- [x] 运行：`node --import tsx --test apps/server/src/test/managed-codex-store.test.ts`。预期：上述行为通过；再运行现有 migration/message-delivery 回归。
- [x] 提交：`feat(server): persist managed Codex tasks and bindings`。

### 任务 3：stdio JSON-RPC 与进程适配

**测试文件：** `managed-codex-rpc.test.ts`、`managed-codex-process.e2e.ts`。

- [x] 先写失败测试：单行分成多个 chunk、多行同一 chunk、CRLF、响应乱序、未知通知、JSON 无效、请求超时、stdout 关闭、child 退出，所有 pending Promise 正确结束。
- [x] rpc.ts 提供 `request(method, params)`、`respond(id, result)`、`onNotification`、`onServerRequest`、`close()`；请求 id 按连接单调递增，连接重建更换 generation，旧回调不得作用于新连接。
- [x] 设置单帧大小上限 4 MiB、最多 128 个在途请求、普通请求超时 30 秒；超限返回明确错误。中断、审批、恢复等待均有可取消的有限超时。
- [x] process.ts 使用 executable + argv，prompt 通过 JSON stdin；复用 runtime-registry/settings/env 配置，不拼接 prompt 到 shell 命令。Windows 要区分实际 exe、node 脚本与 npm cmd shim：解析为可直接执行的 exe 或 node + script；不把 cmd shim 直接交给 shell:false。
- [x] 新子进程使用 `windowsHide: true`，继承明确的项目目录和 CONFLUX_HOME；日志只记录实例/请求标识、错误分类与受控诊断，不打印密钥、完整 env 或原始协议。
- [x] shim 用 `process.execPath` 启动，模拟 initialize、thread、turn、审批、异常退出，并记录收到的 RPC 供测试断言。
- [x] 先跑 RPC 单测，再串行跑 process E2E；预期退出后无 pending request、无残留 shim PID/端口/订阅。
- [x] 提交：`feat(server): add managed Codex stdio transport`。

### 任务 4：受管实例、消息与执行闭环

**测试文件：** `managed-codex-manager.test.ts`、现有 runtime/message-delivery 测试。

- [x] 先写失败测试：initialize 前不能创建 thread；thread ID 到达前保持 starting；同一实例每次只启动一个 turn；忙时第二个任务等待；重复通知不重复回写 reply；失败/中断不变 completed。
- [x] manager.ts 提供启动、enqueue、interrupt、resume、shutdown；首期一个受管实例一个根 thread，进程与绑定由 manager 实际持有。
- [x] runtime-agents.ts 对 managed+codex 分流到 manager；原 terminal 路径默认保持。实例绑定使用真实协议 thread ID 与实际进程身份；同一 thread 的并发 owner 明确冲突。
- [x] ask.ts 在消息准备事务提交后识别受管目标，按原 message ID enqueue；受管消息不调用 wake/codex.ts 或终端 send-keys，也不再启动摘要代理。
- [x] events.ts 根据 `turn/started`、`item/agentMessage/delta`、item 完成与 `turn/completed` 更新 run。最终文本按 item ID 归并，不能重复拼接 delta 与完整 item；只有 completed 终态自动调用现有 reply 核心完成原消息。
- [x] 将 Agent 来源作为明确的消息内容/元数据交给 Codex，不把它描述为用户授权；原始发送会话、实际执行 instance、thread、turn 均可追踪。
- [x] 现有 MCP 接入若也为该进程登记会话，必须按实例/thread 做确定绑定；有冲突则报告，不能用项目路径或最近活动猜测，也不能创建两个代表同一受管 thread 的会话。
- [x] 每个消息执行至少保存一次归一化终态事件；HTTP 响应、DB 重试不重复发 turn/start。
- [x] 运行 focused manager/store/runtime 测试；提交 `feat(server): drive managed Codex tasks from messages`。

### 任务 5：审批与中断

**测试文件：** `managed-codex-approvals.test.ts`、`managed-codex-http.test.ts`。

- [x] 先写失败测试：审批只作用于对应 instance/thread/turn/request；重复回应、已完成 turn、旧连接 generation、过期审批均返回 409；Agent 会话不能代替用户批准。
- [x] 通过版本化 RPC schema 区分 commandExecution 与 fileChange 审批，首期 UI 只提供该请求实际允许的“本次允许 / 拒绝 / 取消”。未知服务端请求明确失败，不能默认批准或永远悬挂。
- [x] 审批内容持久化前脱敏；用户 HTTP 操作复用现有人工控制台身份边界，不接受 body 中伪造 actor。
- [x] `turn/interrupt` 请求成功只表示取消请求已接受；等官方 interrupted 终态后更新状态。停止进程沿用已核验 ownership/process identity，不把中断当杀进程。
- [x] 对外 API：`GET /runtime-instances/:id/managed` 返回 binding、当前 run、队列摘要与 pending approvals；`POST /runtime-instances/:id/managed/interrupt` 携带 expected_turn_id；`POST /runtime-instances/:id/managed/approvals/:approvalId` 携带校验后的 decision。
- [x] 用 Fastify inject 验证非法目标、外部实例、越权 actor、重复请求与协议错误分类。HTTP/CLI/MCP 内部都复用 core；不新增能绕过审批的 Agent 工具。
- [x] 提交 `feat(server): expose managed Codex approvals and interruption`。

### 任务 6：掉线、重启与恢复核对

**测试文件：** `managed-codex-recovery.test.ts`、process E2E。

- [x] 先写失败测试：queued 可继续；RPC 写入后响应前退出不得自动再发；submitting/running 在断线后进入 unknown；完成但 DB 回写前退出能核对终态后补回结果；审批随旧连接失效。
- [x] 服务端启动时读取未完成记录，检验旧进程/owner；无法确认旧 owner 已退出时保持受限状态，不创建并发 writer。
- [x] 用户恢复时用保存的 thread ID 调 `thread/resume`，用 `thread/read` 与保存 turn ID 核对历史。存在已确认完成的 turn 就补终态与原消息结果；不存在确定关联证据时保留 unknown，供用户核对，禁止把相似文本当成功证据。
- [x] submitting 且没有 turn ID 的窗口必须显式展示“执行状态待核对”，不能推断为未运行。首期采用保守人工处理，不声称自动 exactly-once。
- [x] 服务停止时关闭发送入口，过期本连接的 approvals，结束/回收自己的 child 并等待确认，清理 timers/listeners；不终止外部会话。
- [x] 测试只启动 shim，断点覆盖 send 前、send 后、接受后、完成后写库前四个窗口。每个用例核对 turn/start 收到次数与最终 DB 记录。
- [x] 提交 `fix(server): reconcile managed Codex runs after disconnects`。

### 任务 7：最小网页闭环

**测试文件：** `apps/web/test/managed-codex.test.ts`、现有 assistants/collaboration-controls/workspace 测试。

- [x] 增加 `GET /runtime-instances/:id/managed/events?after=<sequence>` SSE，返回归一化事件；重连从 last-event-id/after 续读，旧序号去重，连接取消时释放订阅。历史事件只查询需要展示的页，不能一次加载整个会话。
- [x] API 客户端保留实例/turn 关联；切换实例时 abort 旧请求与流，旧响应不得写入新面板。
- [x] AssistantsTab 为 Codex 预设增加 opt-in 模式选择；RuntimeInstancesPanel 链接受管面板；ManagedCodexPanel 展示真实 binding、执行状态、文本/工具进展、审批与中断。
- [x] 输入仍走现有问答入口，固定收件人；人工恢复与重试显示原任务状态，不能暗中复制一条消息。
- [x] 等待审批、执行失败、unknown、断线和 interrupted 各有文字提示。状态颜色使用 docs/DESIGN-TOKENS.md，按钮保持键盘可达；审批按钮提交期间禁用，过期响应后刷新状态。
- [x] 挂载测试覆盖双击、旧流到达、重连、审批过期和受管/外部实例切换。桌面与 390/320px 窄屏验证无横向溢出；界面测试 fixture 不声称真实模型通过。
- [x] 提交 `feat(web): add managed Codex execution panel`。

### 任务 8：验证与交付

- [x] 运行 affected focused tests，再运行下列完整检查；记录命令、退出码和实际结果，不复制本计划的预期当成实测。

```powershell
npm test -w apps/server
npm run test:process-e2e -w apps/server
npm test -w apps/web
npm run test:desktop
npm run build
npm run lint
npm run check:tokens
npm run check:secrets
```

- [x] 更新 `test:process-e2e` 脚本，使新 process.e2e.ts 与现有真实进程测试串行执行，避免并发负载超过进程检查超时。（glob `*.e2e.ts` 已覆盖，无脚本改动；新受管套件以 .e2e.ts 命名进串行层）
- [x] 用临时 CONFLUX_HOME、独立 CODEX_HOME 和临时项目目录执行实际 CLI 验收（无模型冒烟：initialize 版本核对 + thread/start 真实 UUIDv7 通过；真实模型 turn 未运行，见下）；沿用已有合法登录机制，不从真实配置复制密钥到测试记录。运行真实模型前检查其权限/费用与当前授权边界；如凭据不可用，报告真实验收未完成，不通过 mock 宣称完成。
- [ ] 真机矩阵：新建、第二条排队、工具审批拒绝/允许、中断、进程退出、服务重启恢复、外部线程被占用、两个并发消息；核对原 thread 与原 message ID、执行次数和残留进程。
- [x] docs/MANAGED-CODEX.md 记录支持 CLI 版本、外部会话差异、unknown 处理方法和实测平台。Windows 优先实测；未测的 macOS/Linux 明确标注。
- [x] 按 repo 规则用 gh 创建 feat PR，链接功能 issue、计划、测试与截图。任何 push 前在对话宣布分支和 commits；feat/fix PR 保持开放供用户手动合并，禁止自动合并、发布或发起 dev→main。

## 5. GLM 回报格式

收到后先回复：当前 checkout/worktree、复用或新建 issue、支持的 CLI 版本、是否发现协议与计划冲突。按任务逐项回报：已完成内容、commit、验证命令与结果、明确未完成项。

第一检查点是任务 1–3：在没有真实模型调用的前提下，把数据库和可控 stdio 进程协议跑通，再进入任务执行与 UI。遇到外部 writer 冲突、unknown 状态或未实现审批类型，返回明确限制；不要退回终端输入、摘要代答或默认批准以伪造闭环。

