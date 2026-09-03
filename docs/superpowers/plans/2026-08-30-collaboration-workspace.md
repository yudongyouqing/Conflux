# 协作工作区与运行时工作流实现计划

> 面向 AI 代理的工作者：必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法跟踪进度。

**目标：** 把 Conflux 从图谱查看器扩展为“当前工作区 + 会话列表 + 消息 + 上下文 + 运行时详情”的日常协作闭环。

**架构：** server 新增工作区聚合查询和运行时实例生命周期，仍由 core 统一实现，HTTP、MCP、CLI 只做适配。React 首屏以工作区快照为入口，列表、图谱、消息和详情面板共享同一份会话身份与刷新策略，所有发送、重试、恢复动作都回写审计记录。

**技术栈：** TypeScript、SQLite、Fastify、React 18、TanStack Query、Lucide、Tailwind、Node node:test。

---

## 依赖与边界

本计划依赖 electron-runtime-foundation 计划中的显式 session identity、runtime PID 和桌面 HTTP 边界。不要把业务数据移入 Electron IPC，也不要在前端复制一套会话生命周期规则。当前已有的图谱、消息、上下文和 runtime agent 组件保持兼容，逐步接入新的聚合接口。

## 文件清单

创建：

- apps/server/src/core/workspace.ts：工作区快照和会话详情聚合。
- apps/server/src/core/message-delivery.ts：消息投递唤醒、失败状态和重试策略。
- apps/server/src/core/runtime-instances.ts：运行时实例注册、绑定、停止和恢复。
- apps/server/src/test/workspace.test.ts、message-delivery.test.ts、runtime-instances.test.ts：core 回归测试。
- apps/web/src/components/WorkspaceHome.tsx：当前会话、待处理消息和最近活动首屏。
- apps/web/src/components/RuntimeBadge.tsx：统一 runtime 和状态标识。
- apps/web/src/components/QueryState.tsx：加载、断线、空数据和服务崩溃状态。
- apps/web/src/components/ContextSearch.tsx：上下文全文搜索、标签过滤和来源跳转。
- apps/web/src/components/MessageComposer.tsx：发送、重试和复制动作的共用控件。

修改：

- packages/shared/src/index.ts：增加 WorkspaceSnapshot、SessionDetail、RuntimeInstance 和 DeliveryResult。
- apps/server/src/core/db.ts：增加 runtime_instances 表和迁移版本。
- apps/server/src/core/messages.ts、runtime-agents.ts、live.ts：接入投递和实例绑定。
- apps/server/src/http/server.ts：增加工作区、详情、重试、实例停止和恢复路由。
- apps/server/src/cli/commands.ts、apps/server/src/mcp/server.ts：暴露与 HTTP 一致的工作区和消息动作。
- apps/server/src/test/helpers.ts：补充可注入的唤醒器、终止器和固定时间工具。
- apps/web/src/api.ts、hooks.ts：接入新 API 和 mutation 失效策略。
- apps/web/src/App.tsx、components/Sidebar.tsx：增加工作区入口和全局选中状态。
- apps/web/src/components/SessionsTab.tsx、GraphTab.tsx、DetailPanel.tsx、MessageTab.tsx、MessageCard.tsx、RuntimesTab.tsx：统一字段、筛选、动作和状态展示。
- apps/web/src/index.css：稳定面板、列表、文本截断和键盘焦点样式。
- apps/server/src/test/graph.test.ts、messages.test.ts、runtime-agents.test.ts：跨模块回归测试。

### 任务 1：定义工作区快照和详情契约

**文件：** packages/shared/src/index.ts、apps/server/src/core/workspace.ts、apps/server/src/test/workspace.test.ts、apps/server/src/http/server.ts、apps/server/src/cli/commands.ts、apps/web/src/api.ts。

- [ ] 步骤 1：编写失败的聚合查询测试

`ts
test("builds a workspace snapshot from one consistent query model", () => {
  const db = openTestDb();
  seedSession(db, { id: "codex-1", name: "Codex", runtime: "codex", status: "active" });
  seedSession(db, { id: "claude-1", name: "Claude", runtime: "claude", status: "stale" });
  seedContext(db, { session_id: "codex-1", title: "Decision", content: "Use SQLite" });
  seedMessage(db, { from_session: "web-console", to_session: "codex-1", status: "pending" });

  const snapshot = getWorkspaceSnapshot(db, { status: "all", limit: 10 });
  assert.equal(snapshot.active_sessions[0].id, "codex-1");
  assert.equal(snapshot.pending_messages[0].to_session, "codex-1");
  assert.equal(snapshot.recent_context[0].session_id, "codex-1");
  assert.equal(snapshot.scope, "global");
});

test("returns a complete detail object for a selected session", () => {
  const db = openTestDb();
  seedSession(db, { id: "codex-1", name: "Codex", runtime: "codex" });
  const detail = getSessionDetail(db, "codex-1");
  assert.equal(detail.session.id, "codex-1");
  assert.ok(Array.isArray(detail.context));
  assert.ok(Array.isArray(detail.inbox));
  assert.ok(Array.isArray(detail.sent));
});
`

- [ ] 步骤 2：运行测试确认聚合模块尚未实现

运行：npm test -w apps/server -- --test-name-pattern="workspace snapshot|selected session"。

预期：因 workspace 模块和类型不存在而失败。

- [ ] 步骤 3：实现 core 聚合函数

共享类型固定为：

`ts
export interface WorkspaceSnapshot {
  generated_at: string;
  scope: "global" | "project";
  active_sessions: SessionSummary[];
  stale_sessions: SessionSummary[];
  pending_messages: Message[];
  recent_messages: Message[];
  recent_context: ContextEntry[];
}

export interface SessionDetail {
  session: Session;
  context: ContextEntry[];
  inbox: Message[];
  sent: Message[];
}
`

getWorkspaceSnapshot 调用现有 listSessions、listMessages 和 queryContext，所有 status、limit 和排序在 core 中处理；不能让 HTTP 和前端各自拼接状态。getSessionDetail 只接受 session id，找不到时抛出包含该 id 的错误。

- [ ] 步骤 4：接入 HTTP、CLI 和前端 API

增加 GET /workspace?status=all&limit=50 和 GET /sessions/:id/detail。CLI 增加 workspace 命令，默认输出同一份 JSON；web api 增加 getWorkspace 和 getSessionDetail，接口返回类型直接引用 shared 类型。

- [ ] 步骤 5：运行接口回归测试和构建

运行：

`powershell
npm test -w apps/server -- --test-name-pattern="workspace"
npm run build -w packages/shared
npm run build -w apps/server
`

预期：core 测试、接口编译和 shared/server 构建全部通过。

- [ ] 步骤 6：Commit

`powershell
git add packages/shared/src/index.ts apps/server/src/core/workspace.ts apps/server/src/test/workspace.test.ts apps/server/src/http/server.ts apps/server/src/cli/commands.ts apps/web/src/api.ts
git commit -m "feat: add workspace snapshot API"
`

### 任务 2：实现消息投递状态、失败提示和重试

**文件：** apps/server/src/core/message-delivery.ts、apps/server/src/test/message-delivery.test.ts、apps/server/src/core/messages.ts、apps/server/src/http/server.ts、apps/server/src/mcp/server.ts、packages/shared/src/index.ts、apps/web/src/api.ts、apps/web/src/hooks.ts。

- [ ] 步骤 1：编写失败和重试测试

`ts
test("reports queued delivery when the target is offline", () => {
  const db = openTestDb();
  seedSession(db, { id: "offline", status: "stale" });
  const result = deliverMessage(db, 7, {
    wake: () => ({ woke: false, reason: "runtime is offline" }),
  });
  assert.deepEqual(result, {
    state: "queued",
    woke: false,
    reason: "runtime is offline",
  });
});

test("retries only pending messages and records the wake result", () => {
  const db = openTestDb();
  seedPendingMessage(db, { id: 9, to_session: "codex-1" });
  const result = retryMessage(db, 9, {
    wake: () => ({ woke: true, instance_id: "run-1" }),
  });
  assert.deepEqual(result, { state: "woken", woke: true, instance_id: "run-1" });
  assert.throws(
    () => retryMessage(db, 9, { wake: () => ({ woke: true }) }),
    /message 9 is not pending/
  );
});
`

- [ ] 步骤 2：运行测试确认投递模块尚未实现

运行：npm test -w apps/server -- --test-name-pattern="delivery|retries only"。

预期：因投递结果和 retryMessage 不存在而失败。

- [ ] 步骤 3：实现可注入的投递协调器

message-delivery.ts 定义 DeliveryResult 为 queued、woken 或 failed，只接收 message id 和注入的 wake 函数，避免测试启动真实 Claude/Codex。ask_session 和 /web/ask 创建消息后调用该协调器；数据库仍保留 pending/seen/replied/read 语义，投递结果作为响应和审计结果返回，不把失败伪装成已送达。

- [ ] 步骤 4：增加 HTTP/MCP 重试入口

增加 POST /messages/:id/retry，只允许消息接收方或发送方按当前消息权限重试；无效 id、已回复消息和非 pending 消息分别返回 404、409 和明确错误。MCP 增加 retry_delivery 工具，工具 stdout 只输出 JSON-RPC。所有路径都写入 audit，args 只记录 message id，不记录完整问题正文。

- [ ] 步骤 5：运行消息回归测试

运行：

`powershell
npm test -w apps/server -- --test-name-pattern="message|delivery"
npm run build -w apps/server
`

预期：原有消息生命周期不变，新增投递和重试测试通过，构建退出码为 0。

- [ ] 步骤 6：Commit

`powershell
git add packages/shared/src/index.ts apps/server/src/core/message-delivery.ts apps/server/src/test/message-delivery.test.ts apps/server/src/core/messages.ts apps/server/src/http/server.ts apps/server/src/mcp/server.ts apps/web/src/api.ts apps/web/src/hooks.ts
git commit -m "feat: add message delivery retry"
`

### 任务 3：建立运行时实例生命周期

**文件：** apps/server/src/core/db.ts、packages/shared/src/index.ts、apps/server/src/core/runtime-instances.ts、apps/server/src/test/runtime-instances.test.ts、apps/server/src/core/runtime-agents.ts、apps/server/src/core/live.ts、apps/server/src/mcp/server.ts、apps/server/src/http/server.ts。

- [ ] 步骤 1：编写实例状态转换测试

`ts
test("creates, binds, and ends a runtime instance", () => {
  const db = openTestDb();
  const created = createRuntimeInstance(db, {
    agent_id: 3, runtime: "codex", project_dir: "C:/repo",
  });
  assert.equal(created.status, "starting");
  const bound = bindRuntimeInstance(db, created.id, {
    session_id: "codex-session", pid: 4321,
  });
  assert.equal(bound.status, "active");
  assert.equal(bound.session_id, "codex-session");
  assert.equal(endRuntimeInstance(db, created.id, "stopped").status, "ended");
});

test("stop uses the injected process terminator and is idempotent", () => {
  const db = openTestDb();
  const instance = seedRuntimeInstance(db, {
    id: "run-1", pid: 4321, status: "active",
  });
  const killed = [];
  stopRuntimeInstance(db, instance.id, {
    terminate: (pid) => killed.push(pid),
  });
  stopRuntimeInstance(db, instance.id, {
    terminate: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [4321]);
});
`

- [ ] 步骤 2：运行测试确认实例表和生命周期尚未实现

运行：npm test -w apps/server -- --test-name-pattern="runtime instance"。

预期：因 runtime_instances 表和生命周期函数不存在而失败。

- [ ] 步骤 3：添加 schema migration 和 core 生命周期

新增 runtime_instances 表：

`sql
CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY,
  agent_id INTEGER,
  runtime TEXT NOT NULL,
  project_dir TEXT,
  session_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT,
  ended_at TEXT,
  error TEXT
);
CREATE INDEX idx_runtime_instances_session ON runtime_instances(session_id);
CREATE INDEX idx_runtime_instances_status ON runtime_instances(status);
`

实例状态只允许 starting、active、stale、ended、failed。createRuntimeInstance 生成稳定实例 id；bindRuntimeInstance 同时更新 session 的 runtime、runtime_pid 和 instance metadata；stopRuntimeInstance 只对 active/starting 实例执行一次终止，结束结果写入 ended_at 和 audit。

- [ ] 步骤 4：接入启动、Hook/MCP 绑定和恢复

buildRuntimeEnv 增加 MUILTCHAT_RUNTIME_INSTANCE_ID。runtime agent 启动返回 instance_id、opener 和 session_id；Hook/MCP 注册时从该变量绑定实例。增加 POST /runtime-instances/:id/stop 和 POST /runtime-instances/:id/resume，resume 使用已绑定的 session id、runtime 和 project_dir 调用现有 terminal opener，并设置 MUILTCHAT_ASSUME_SESSION。所有 PID 终止调用都通过可注入函数测试，生产 Windows 使用 taskkill /T /F。

- [ ] 步骤 5：运行 runtime 回归测试

运行：

`powershell
npm test -w apps/server -- --test-name-pattern="runtime|agent"
npm run build -w apps/server
`

预期：runtime agent 原有创建和启动测试通过，实例状态、绑定、停止和恢复测试通过。

- [ ] 步骤 6：Commit

`powershell
git add apps/server/src/core/db.ts packages/shared/src/index.ts apps/server/src/core/runtime-instances.ts apps/server/src/test/runtime-instances.test.ts apps/server/src/core/runtime-agents.ts apps/server/src/core/live.ts apps/server/src/mcp/server.ts apps/server/src/http/server.ts
git commit -m "feat: track runtime instances"
`

### 任务 4：创建当前工作区首屏

**文件：** apps/web/src/components/WorkspaceHome.tsx、RuntimeBadge.tsx、QueryState.tsx、apps/web/src/App.tsx、components/Sidebar.tsx、hooks.ts、index.css。

- [ ] 步骤 1：实现工作区数据 hook

增加 useWorkspace，默认请求 status=all、limit=50，使用 5 秒刷新；服务未就绪时不把空数组当作成功数据，保留 query error 给 QueryState 显示。选中会话 id 存在但快照刷新后消失时，清空选中状态。

- [ ] 步骤 2：实现首屏布局

新增 WorkspaceHome：顶部显示当前活动会话和服务状态；主区域显示活跃会话、待处理消息、最近上下文和最近消息；每一项点击后调用 App 的统一选择回调。默认 tab 改为 workspace，原 graph 入口保留。列表项使用稳定的 grid/flex 尺寸，长标题和项目路径截断，不允许刷新时改变布局。

- [ ] 步骤 3：实现运行时标识和查询状态

RuntimeBadge 只从 shared runtime/status 字段渲染 Codex、Claude、内部 Agent 或 Web；QueryState 覆盖 loading、empty、offline、starting 和 crashed 五种状态，并提供重新请求动作。错误信息只显示可操作摘要，不把 server 原始堆栈直接渲染到页面。

- [ ] 步骤 4：运行前端构建

运行：npm run build -w apps/web。

预期：TypeScript 和 Vite 构建通过，所有现有 tab 仍可编译。

- [ ] 步骤 5：Commit

`powershell
git add apps/web/src/components/WorkspaceHome.tsx apps/web/src/components/RuntimeBadge.tsx apps/web/src/components/QueryState.tsx apps/web/src/App.tsx apps/web/src/components/Sidebar.tsx apps/web/src/hooks.ts apps/web/src/index.css
git commit -m "feat: add collaboration workspace home"
`

### 任务 5：完善会话、上下文和消息工作流

**文件：** apps/web/src/components/ContextSearch.tsx、MessageComposer.tsx、apps/web/src/api.ts、hooks.ts、components/SessionsTab.tsx、GraphTab.tsx、DetailPanel.tsx、MessageTab.tsx、MessageCard.tsx、RuntimesTab.tsx。

- [ ] 步骤 1：补充会话筛选和分组行为

SessionsTab 增加关键词、runtime、status 和项目过滤；活跃会话按 last_heartbeat_at 降序，stale/ended 放入默认折叠区；每个条目显示名称、runtime、项目目录、最近心跳和待回复数。筛选逻辑放在纯函数中，保证 SessionsTab 与 WorkspaceHome 使用相同结果。

- [ ] 步骤 2：补充详情身份和恢复动作

DetailPanel 显示 session id、名称、runtime、identity_source、项目、PID、最近心跳和状态；复制 id 使用 Clipboard API 并给出成功/失败反馈；上下文条目显示来源会话和更新时间；“在终端打开”调用 resume 路由，离线时先显示异步恢复状态。

- [ ] 步骤 3：补充消息和上下文闭环

ContextSearch 支持空查询最近列表、关键词、session 和 tags，并提供跳转来源会话动作。MessageTab/MessageCard 显示 pending、seen、replied、read、queued、failed 状态；失败项调用 retry mutation，成功后只失效相关消息、会话和 graph 查询。MessageComposer 的发送按钮、Enter 提交、正在发送和失败重试状态使用固定高度，长文本可展开和复制。

- [ ] 步骤 4：统一图谱选择和刷新

GraphTab 节点点击打开同一 DetailPanel；节点名称只是显示字段，runtime/session id 共同展示；图谱过滤与 SessionsTab 复用 status/runtime 规则。图谱刷新不能重置用户正在查看的详情或边通道。

- [ ] 步骤 5：运行前端构建与服务端接口测试

运行：

`powershell
npm run build -w apps/web
npm test -w apps/server -- --test-name-pattern="workspace|message|graph"
`

预期：前端构建和服务端接口回归通过，API 类型无漂移。

- [ ] 步骤 6：Commit

`powershell
git add apps/web/src/api.ts apps/web/src/hooks.ts apps/web/src/components/ContextSearch.tsx apps/web/src/components/MessageComposer.tsx apps/web/src/components/SessionsTab.tsx apps/web/src/components/GraphTab.tsx apps/web/src/components/DetailPanel.tsx apps/web/src/components/MessageTab.tsx apps/web/src/components/MessageCard.tsx
git commit -m "feat: complete session collaboration workflow"
`

### 任务 6：补齐断线、键盘和审计体验

**文件：** apps/web/src/components/QueryState.tsx、apps/web/src/App.tsx、apps/web/src/index.css、apps/server/src/core/audit.ts、apps/server/src/http/server.ts、apps/server/src/test/audit.test.ts。

- [ ] 步骤 1：添加审计断言

测试删除、结束、重试、恢复动作都产生 interface、action、caller_session、result；args 中不出现 api_key、完整上下文正文或完整 API 响应。

- [ ] 步骤 2：实现错误和恢复状态

HTTP 路由把数据库锁冲突、数据损坏、404、409 和服务未启动映射为稳定错误码和用户可读 message；前端根据错误码渲染重试、重新连接、返回列表或打开设置动作。server 原始 stack 只写 stderr/logger，不写入 response。

- [ ] 步骤 3：实现键盘和可访问性

列表条目使用 button，支持 Tab、Enter、Escape；详情面板支持 Escape 清除选择；复制动作失败时显示非阻塞提示。为图标按钮添加 title/aria-label，焦点环和文本截断样式不改变固定布局。

- [ ] 步骤 4：运行验证

运行：

`powershell
npm test -w apps/server
npm run build
npm run dev:desktop
`

预期：server 全量测试和根构建通过；Electron 打开后能完成“当前会话 -> 选择目标 -> 发送问题 -> 查看 pending/replied -> 复制上下文 -> 恢复终端”的流程。

- [ ] 步骤 5：Commit

`powershell
git add apps/web/src/components/QueryState.tsx apps/web/src/App.tsx apps/web/src/index.css apps/server/src/core/audit.ts apps/server/src/http/server.ts apps/server/src/test/audit.test.ts
git commit -m "feat: harden collaboration states and audit"
`

### 任务 7：阶段二验收

**文件：** 验证本计划的所有 server、shared、web 文件。

- [ ] 步骤 1：运行分层测试

`powershell
npm test -w apps/server
npm run build -w packages/shared
npm run build -w apps/web
node --test apps/desktop/test/*.test.cjs
`

预期：所有测试退出码为 0，shared 类型、server API 和 web API 完全一致。

- [ ] 步骤 2：执行一次真实协作流程

启动 npm run dev:desktop，让一个 Codex MCP 会话和一个 Claude MCP 会话在线；在工作区首屏选择 Codex，发布上下文并发送问题；在消息详情查看 pending、回复后的 replied，再打开上下文来源并从详情恢复目标终端。停止目标运行时后重试一条 pending 消息，页面显示 queued 或 failed 的明确结果。

- [ ] 步骤 3：检查敏感信息

运行：rg -n "OPENAI_API_KEY|ANTHROPIC_API_KEY|api_key" apps/web apps/server/src/test docs。

预期：只出现字段名、配置状态或测试占位符，不出现真实凭据；审计和界面不显示完整 key。

- [ ] 步骤 4：Commit 验收记录

`powershell
git add docs/superpowers/plans/2026-08-30-collaboration-workspace.md
git commit -m "docs: record collaboration workspace plan"
`
