# Codex 存活检测实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Conflux 同时可靠识别 Claude Code 和 Codex 会话的存活状态。

**架构：** 将进程命令识别、PID 快照和会话 reconcile 抽象为运行时无关逻辑；保留现有 Claude 导出函数作为兼容包装。Hook 与 MCP 通过运行时标识和祖先进程 PID 关联会话，HTTP 服务每 30 秒同时探测两个运行时；没有 PID 的会话继续使用 heartbeat TTL。

**技术栈：** TypeScript、Node.js `child_process`、SQLite/better-sqlite3、Node test runner、MCP stdio transport。

---

### 任务 1：扩展 liveness 单元测试

**文件：**
- 修改：`apps/server/src/test/liveness.test.ts`
- 参考：`apps/server/src/core/liveness.ts`

- [x] **步骤 1：编写失败的测试**

补充 Codex CLI、Node 包路径和相似文件名的识别测试；补充同时返回 Claude/Codex PID 的快照测试；补充带 `runtime: "codex"` 和 `runtime_pid` 的 active/stale reconcile 测试，并验证无 PID 行为保持不变。

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -w apps/server -- --test-name-pattern=codex`

预期：新增测试因 `isRuntimeCommand`、`probeRuntimePids` 或 Codex reconcile 支持尚不存在而失败，现有 Claude 测试仍可加载。

### 任务 2：实现运行时无关的 PID 探测和 reconcile

**文件：**
- 修改：`apps/server/src/core/liveness.ts`

- [x] **步骤 1：实现最少代码让测试通过**

添加 `RuntimeId` 级别的命令识别、PID 提取和双运行时探测；识别 `claude`、`@anthropic-ai/claude-code`、`codex`、`@openai/codex` 和 `codex-cli`，避免把 `my-codex-notes.md` 等相似文件名当成 CLI。reconcile 读取 `runtime_pid`，同时兼容旧 `claude_pid`，并只在对应运行时 PID 存活时刷新心跳。

- [x] **步骤 2：运行 liveness 测试验证通过**

运行：`npm test -w apps/server -- --test-name-pattern=liveness`

预期：Claude 与 Codex liveness 测试全部通过。

### 任务 3：记录 Codex 祖先进程并接入 MCP adoption

**文件：**
- 修改：`apps/server/src/core/live.ts`
- 修改：`apps/server/src/mcp/server.ts`

- [x] **步骤 1：实现通用运行时 PID 解析**

在 `live.ts` 添加运行时参数化的祖先进程查找，保留 `getClaudePid()` 包装；为 `findSessionByRuntimePid()` 添加精确 JSON metadata 匹配，保留 Claude 查询包装。

- [x] **步骤 2：记录和采用 Codex 会话**

让 Hook/MCP 根据 `MUILTCHAT_AGENT_RUNTIME` 选择运行时，并在自动注册的 MCP 临时会话中记录 `runtime` 与 `runtime_pid`。adoption 先使用显式 session、运行时 pin，再按运行时 PID 查找，Claude 旧行为保持不变。

- [x] **步骤 3：运行服务器测试和构建**

运行：`npm test -w apps/server` 和 `npm run build -w apps/server`

预期：服务器测试全部通过，TypeScript 构建退出码为 0。

### 任务 4：让 HTTP 服务探测两个运行时并做回归验证

**文件：**
- 修改：`apps/server/src/http/server.ts`

- [x] **步骤 1：切换 HTTP liveness tick**

使用统一探测结果调用统一 reconcile，探测失败时保留 heartbeat TTL fallback。

- [x] **步骤 2：执行全量验证**

运行：`npm test -w apps/server`、`node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs`、`npm run build`

预期：相关测试全部通过，根目录构建退出码为 0；最后检查 `git diff`，确认只包含本功能需要的文件。
