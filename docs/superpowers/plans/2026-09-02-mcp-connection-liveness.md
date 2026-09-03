# MCP 连接租约探活实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Conflux 以 MCP stdio 连接租约判断 Codex/Claude 会话在线状态，避免仅凭 CLI 进程存在产生误报。

**架构：** 每个 MCP 进程生成唯一 `mcp_connection_id`，通过 metadata 记录连接代际、连接状态和最后续租时间。MCP 心跳、stdin EOF/close 和 transport `onclose` 负责连接生命周期；HTTP 服务负责租约过期回收。PID 探测保留给运行时身份关联和没有新租约的旧会话，不再正向刷新有租约会话。

**技术栈：** TypeScript、Node.js `StdioServerTransport`、Node `Readable` 事件、SQLite/better-sqlite3、Node test runner、Fastify 定时任务。

---

## 文件清单与职责

- 创建：`apps/server/src/core/mcp-liveness.ts` — MCP 租约 metadata、条件更新、TTL 回收和可测试的 stdio 生命周期绑定。
- 创建：`apps/server/src/test/mcp-liveness.test.ts` — 租约代际、过期、断开幂等和 fake stdin/transport 测试。
- 修改：`apps/server/src/core/liveness.ts` — PID reconcile 跳过带 MCP 租约的会话，保留旧会话兼容行为。
- 修改：`apps/server/src/test/liveness.test.ts` — 验证有 MCP 租约的会话不被 PID 快照刷新或立即回收。
- 修改：`apps/server/src/mcp/server.ts` — 生成 token、续租、adoption 后转移 token、监听 stdin 和 MCP transport 关闭。
- 修改：`apps/server/src/http/server.ts` — 抽出可注入探针的统一 liveness tick，在 PID 探测前执行 MCP 租约回收。
- 创建：`apps/server/src/test/http-liveness.test.ts` — 验证 HTTP liveness tick 同时回收过期 MCP 租约并保留旧 PID reconcile。
- 修改：`docs/TROUBLESHOOTING.md` — 说明“在线”代表 MCP 连接可用，不代表终端窗口可见，并记录从当前功能分支验证的启动要求。

本计划不修改 `packages/shared`、MCP 工具名称、HTTP 路径或数据库表结构；新字段全部位于已有 session metadata，旧行继续使用原兼容逻辑。

### 任务 1：实现 MCP 租约 Core API

**文件：**
- 创建：`apps/server/src/test/mcp-liveness.test.ts`
- 创建：`apps/server/src/core/mcp-liveness.ts`

- [x] **步骤 1：编写失败测试**

先创建隔离数据库和动态模块加载，确保模块缺失时测试以明确断言失败，而不是因为测试导入拼写错误直接崩溃。测试覆盖 token 创建、续租、连接代际保护和 TTL 回收：

```typescript
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { registerSession } from "../core/sessions.js";

type Api = {
  createMcpLeaseMetadata?: (connectionId: string, now?: Date) => Record<string, unknown>;
  claimMcpConnection?: (db: unknown, id: string, connectionId: string, now?: Date) => boolean;
  touchMcpConnection?: (db: unknown, id: string, connectionId: string, now?: Date) => boolean;
  markMcpDisconnected?: (
    db: unknown,
    id: string,
    connectionId: string,
    reason: string,
    now?: Date
  ) => boolean;
  expireMcpLeases?: (db: unknown, now?: Date) => { expired: number };
  installMcpStdioLifecycle?: (
    stdin: unknown,
    transport: unknown,
    onDisconnect: (reason: string) => void
  ) => () => void;
};

const { db, cleanup } = makeDb();
after(cleanup);

async function loadApi(): Promise<Api> {
  try {
    return (await import("../core/mcp-liveness.js")) as unknown as Api;
  } catch {
    return {};
  }
}

test("MCP lease metadata has one connected generation and timestamp", async () => {
  const api = await loadApi();
  assert.equal(typeof api.createMcpLeaseMetadata, "function", "lease API is not implemented");
  const now = new Date("2026-09-02T10:00:00.000Z");
  const metadata = api.createMcpLeaseMetadata!("connection-a", now);
  assert.deepEqual(metadata, {
    mcp_connection_id: "connection-a",
    mcp_connected_at: now.toISOString(),
    mcp_last_heartbeat_at: now.toISOString(),
    mcp_connection_state: "connected",
  });
});

test("new MCP connection replaces an old generation without old close killing it", async () => {
  const api = await loadApi();
  assert.equal(typeof api.claimMcpConnection, "function", "claim API is not implemented");
  assert.equal(typeof api.markMcpDisconnected, "function", "disconnect API is not implemented");

  registerSession(db, {
    id: "lease-generation-session",
    name: "lease-generation-session",
    metadata: { runtime: "codex", runtime_pid: 7101 },
  });
  assert.equal(
    api.claimMcpConnection!(db, "lease-generation-session", "new-connection", new Date()),
    true
  );
  assert.equal(
    api.markMcpDisconnected!(
      db,
      "lease-generation-session",
      "old-connection",
      "transport-close",
      new Date()
    ),
    false
  );
  assert.equal(
    (db.prepare("SELECT status FROM sessions WHERE id = ?").get("lease-generation-session") as { status: string }).status,
    "active"
  );
});

test("silent MCP lease expires and records a disconnected state", async () => {
  const api = await loadApi();
  assert.equal(typeof api.createMcpLeaseMetadata, "function", "lease API is not implemented");
  assert.equal(typeof api.expireMcpLeases, "function", "expiry API is not implemented");

  const connectedAt = new Date("2026-09-02T10:00:00.000Z");
  registerSession(db, {
    id: "lease-expiry-session",
    name: "lease-expiry-session",
    metadata: {
      runtime: "codex",
      runtime_pid: 7201,
      ...api.createMcpLeaseMetadata!("expiry-connection", connectedAt),
    },
  });
  const result = api.expireMcpLeases!(db, new Date("2026-09-02T10:01:31.000Z"));
  assert.equal(result.expired, 1);
  const row = db.prepare("SELECT status, metadata FROM sessions WHERE id = ?").get("lease-expiry-session") as {
    status: string;
    metadata: string;
  };
  assert.equal(row.status, "stale");
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  assert.equal(metadata.mcp_connection_state, "disconnected");
  assert.equal(metadata.mcp_disconnect_reason, "lease-expired");
});
```

- [x] **步骤 2：运行测试确认红灯**

运行：`npm test -w apps/server -- --test-name-pattern="MCP lease"`

预期：失败，至少包含 `lease API is not implemented`；失败原因是待实现行为缺失，不是测试文件加载错误。

- [x] **步骤 3：实现最少租约 API**

创建 `apps/server/src/core/mcp-liveness.ts`，使用 metadata 原值条件更新保护连接代际。实现以下完整接口和常量：

```typescript
import type { DB } from "./db.js";

export const MCP_HEARTBEAT_INTERVAL_MS = 15_000;
export const MCP_LEASE_TTL_MS = 90_000;

export type McpConnectionState = "connected" | "disconnected";

interface SessionRow {
  id: string;
  status: string;
  metadata: string | null;
  last_heartbeat_at: string;
}

function readMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getSessionRow(db: DB, id: string): SessionRow | null {
  return (db.prepare(
    `SELECT id, status, metadata, last_heartbeat_at FROM sessions WHERE id = ?`
  ).get(id) as SessionRow | undefined) ?? null;
}

function metadataGuard(row: SessionRow): string {
  return row.metadata === null ? "id = ? AND metadata IS NULL" : "id = ? AND metadata = ?";
}

function guardArgs(row: SessionRow): unknown[] {
  return row.metadata === null ? [row.id] : [row.id, row.metadata];
}

export function createMcpLeaseMetadata(
  connectionId: string,
  now: Date = new Date()
): Record<string, unknown> {
  const iso = now.toISOString();
  return {
    mcp_connection_id: connectionId,
    mcp_connected_at: iso,
    mcp_last_heartbeat_at: iso,
    mcp_connection_state: "connected" satisfies McpConnectionState,
  };
}

export function hasMcpConnection(metadata: Record<string, unknown>): boolean {
  return typeof metadata.mcp_connection_id === "string" && metadata.mcp_connection_id.length > 0;
}

export function claimMcpConnection(
  db: DB,
  id: string,
  connectionId: string,
  now: Date = new Date()
): boolean {
  const row = getSessionRow(db, id);
  if (!row || row.status === "ended") return false;
  const current = readMetadata(row.metadata);
  if (!current) return false;
  const next = { ...current, ...createMcpLeaseMetadata(connectionId, now) };
  const iso = now.toISOString();
  const result = db.prepare(
    `UPDATE sessions
        SET metadata = ?, status = 'active', last_heartbeat_at = ?
      WHERE ${metadataGuard(row)}`
  ).run(JSON.stringify(next), iso, ...guardArgs(row));
  return result.changes === 1;
}

export function touchMcpConnection(
  db: DB,
  id: string,
  connectionId: string,
  now: Date = new Date()
): boolean {
  const row = getSessionRow(db, id);
  if (!row || row.status === "ended") return false;
  const current = readMetadata(row.metadata);
  if (!current) return false;
  if (
    current.mcp_connection_id !== connectionId ||
    current.mcp_connection_state !== "connected"
  ) {
    return false;
  }
  const iso = now.toISOString();
  const next = {
    ...current,
    mcp_last_heartbeat_at: iso,
  };
  const result = db.prepare(
    `UPDATE sessions
        SET metadata = ?, status = 'active', last_heartbeat_at = ?
      WHERE ${metadataGuard(row)}`
  ).run(JSON.stringify(next), iso, ...guardArgs(row));
  return result.changes === 1;
}

export function markMcpDisconnected(
  db: DB,
  id: string,
  connectionId: string,
  reason: string,
  now: Date = new Date()
): boolean {
  const row = getSessionRow(db, id);
  if (!row) return false;
  const current = readMetadata(row.metadata);
  if (!current) return false;
  if (current.mcp_connection_id !== connectionId) return false;
  const next = {
    ...current,
    mcp_connection_state: "disconnected" satisfies McpConnectionState,
    mcp_disconnected_at: now.toISOString(),
    mcp_disconnect_reason: reason,
  };
  const result = db.prepare(
    `UPDATE sessions
        SET metadata = ?,
            status = CASE WHEN status = 'active' THEN 'stale' ELSE status END
      WHERE ${metadataGuard(row)}`
  ).run(JSON.stringify(next), ...guardArgs(row));
  return result.changes === 1;
}

export function expireMcpLeases(
  db: DB,
  now: Date = new Date()
): { expired: number } {
  const rows = db.prepare(
    `SELECT id, status, metadata, last_heartbeat_at FROM sessions
      WHERE metadata LIKE '%"mcp_connection_id":%' AND status = 'active'`
  ).all() as SessionRow[];
  let expired = 0;
  for (const row of rows) {
    const metadata = readMetadata(row.metadata);
    if (!metadata) continue;
    if (
      !hasMcpConnection(metadata) ||
      metadata.mcp_connection_state !== "connected"
    ) {
      continue;
    }
    const last = typeof metadata.mcp_last_heartbeat_at === "string"
      ? Date.parse(metadata.mcp_last_heartbeat_at)
      : Date.parse(row.last_heartbeat_at);
    if (!Number.isFinite(last) || now.getTime() - last < MCP_LEASE_TTL_MS) continue;
    if (markMcpDisconnected(db, row.id, String(metadata.mcp_connection_id), "lease-expired", now)) {
      expired++;
    }
  }
  return { expired };
}
```

- [x] **步骤 4：运行租约测试确认绿灯**

运行：`npm test -w apps/server -- --test-name-pattern="MCP lease"`

预期：3 个租约测试通过，输出无异常堆栈。

- [x] **步骤 5：Commit**

```bash
git add apps/server/src/core/mcp-liveness.ts apps/server/src/test/mcp-liveness.test.ts
git commit -m "feat: add MCP connection lease helpers"
```

### 任务 2：限制 PID reconcile 的作用范围

**文件：**
- 修改：`apps/server/src/core/liveness.ts`
- 修改：`apps/server/src/test/liveness.test.ts`

- [x] **步骤 1：先增加有租约会话的失败测试**

在 `liveness.test.ts` 增加 helper import 和测试：

```typescript
import { createMcpLeaseMetadata } from "../core/mcp-liveness.js";

test("reconcileRuntimeLiveness does not refresh or reap an MCP-leased session", () => {
  const leaseTime = new Date("2026-09-02T10:00:00.000Z");
  registerSession(db, {
    id: "mcp-pid-boundary",
    name: "mcp-pid-boundary",
    metadata: {
      runtime: "codex",
      runtime_pid: 7310,
      ...createMcpLeaseMetadata("mcp-pid-boundary-connection", leaseTime),
    },
  });
  const oldHeartbeat = new Date("2026-09-02T09:00:00.000Z").toISOString();
  db.prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?").run(
    oldHeartbeat,
    "mcp-pid-boundary"
  );

  reconcileRuntimeLiveness(
    db,
    { claude: new Set(), codex: new Set([7310]) },
    leaseTime
  );
  let row = db.prepare(
    "SELECT status, last_heartbeat_at FROM sessions WHERE id = ?"
  ).get("mcp-pid-boundary") as { status: string; last_heartbeat_at: string };
  assert.equal(row.status, "active");
  assert.equal(row.last_heartbeat_at, oldHeartbeat, "PID must not refresh MCP lease");

  reconcileRuntimeLiveness(
    db,
    { claude: new Set(), codex: new Set() },
    leaseTime
  );
  row = db.prepare(
    "SELECT status, last_heartbeat_at FROM sessions WHERE id = ?"
  ).get("mcp-pid-boundary") as { status: string; last_heartbeat_at: string };
  assert.equal(row.status, "active", "missing PID must not kill a live MCP lease");
  assert.equal(row.last_heartbeat_at, oldHeartbeat);
});
```

- [x] **步骤 2：运行测试确认红灯**

运行：`npm test -w apps/server -- --test-name-pattern="MCP-leased session"`

预期：失败，现有 `reconcileRuntimeLiveness()` 会把 heartbeat 刷新为 `leaseTime`，第二次调用还会把会话标记为 `stale`。

- [x] **步骤 3：实现 PID 边界**

在 `liveness.ts` 引入 `hasMcpConnection`，解析 metadata 后在 `metadataRuntimePid()` 之后增加以下分支；有 token 的会话完全交给 MCP lease controller：

```typescript
import { hasMcpConnection } from "./mcp-liveness.js";

// inside reconcileRuntimeLiveness() after JSON.parse(row.metadata ?? "{}")
const metadata = JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
if (hasMcpConnection(metadata)) continue;
const identity = metadataRuntimePid(metadata);
if (!identity) continue;
```

同时更新函数注释，明确“有 MCP 租约的会话由连接心跳/TTL 管理；无租约行保留现有 PID reconcile”。不改变 `probeRuntimePids()`、旧 `claude_pid` 解析或 `reconcileLiveness()` 兼容包装。

- [x] **步骤 4：运行 liveness 回归测试确认绿灯**

运行：`npm test -w apps/server -- --test-name-pattern="liveness|MCP-leased"`

预期：新增边界测试和既有 Claude/Codex PID 测试全部通过。

- [x] **步骤 5：Commit**

```bash
git add apps/server/src/core/liveness.ts apps/server/src/test/liveness.test.ts
git commit -m "fix: keep PID probing out of MCP lease state"
```

### 任务 3：覆盖 stdin/transport 断开的可测试生命周期

**文件：**
- 修改：`apps/server/src/core/mcp-liveness.ts`
- 修改：`apps/server/src/test/mcp-liveness.test.ts`

- [x] **步骤 1：编写 fake stdin/transport 失败测试**

追加以下测试类型和用例，验证 stdin 的两个事件只请求一次 close，transport 的 close 回调只通知一次：

```typescript
class FakeStdin {
  private listeners = new Map<string, Set<() => void>>();

  on(event: "end" | "close", listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: "end" | "close", listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "end" | "close"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

test("stdin EOF closes MCP transport once and reports one disconnect", async () => {
  const api = await loadApi();
  assert.equal(typeof api.installMcpStdioLifecycle, "function", "stdio lifecycle API is not implemented");
  const stdin = new FakeStdin();
  const reasons: string[] = [];
  let closeCalls = 0;
  const transport: { onclose?: () => void; close: () => Promise<void> } = {
    close: async () => {
      closeCalls++;
      transport.onclose?.();
    },
  };
  const dispose = api.installMcpStdioLifecycle!(stdin, transport, (reason) => reasons.push(reason));

  stdin.emit("end");
  stdin.emit("close");
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.deepEqual(reasons, ["transport-close"]);
  dispose();
});

test("repeated transport close notifications are idempotent", async () => {
  const api = await loadApi();
  assert.equal(typeof api.installMcpStdioLifecycle, "function", "stdio lifecycle API is not implemented");
  const stdin = new FakeStdin();
  const reasons: string[] = [];
  const transport: { onclose?: () => void; close: () => Promise<void> } = {
    close: async () => {},
  };
  const dispose = api.installMcpStdioLifecycle!(stdin, transport, (reason) => reasons.push(reason));
  transport.onclose?.();
  transport.onclose?.();
  assert.deepEqual(reasons, ["transport-close"]);
  dispose();
});
```

- [x] **步骤 2：运行测试确认红灯**

运行：`npm test -w apps/server -- --test-name-pattern="stdin EOF|transport close notifications"`

预期：失败，错误信息为 `stdio lifecycle API is not implemented`。

- [x] **步骤 3：实现 stdio 生命周期绑定**

在 `mcp-liveness.ts` 追加以下结构。该函数在 `server.connect(transport)` 之前调用，保留 SDK 连接时包装 `onclose` 的行为：

```typescript
export interface StdioEventSource {
  on(event: "end" | "close", listener: () => void): void;
  off(event: "end" | "close", listener: () => void): void;
}

export interface StdioCloseableTransport {
  onclose?: () => void;
  close(): Promise<void>;
}

export function installMcpStdioLifecycle(
  stdin: StdioEventSource,
  transport: StdioCloseableTransport,
  onDisconnect: (reason: string) => void
): () => void {
  let notified = false;
  let closeRequested = false;
  const notify = (reason: string) => {
    if (notified) return;
    notified = true;
    onDisconnect(reason);
  };
  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      previousOnClose?.();
    } finally {
      notify("transport-close");
    }
  };
  const requestClose = () => {
    if (closeRequested) return;
    closeRequested = true;
    void transport.close().then(
      () => notify("stdin-close"),
      () => notify("stdin-close-failed")
    );
  };
  stdin.on("end", requestClose);
  stdin.on("close", requestClose);
  return () => {
    stdin.off("end", requestClose);
    stdin.off("close", requestClose);
  };
}
```

- [x] **步骤 4：运行 stdio 测试确认绿灯**

运行：`npm test -w apps/server -- --test-name-pattern="MCP lease|stdin EOF|transport close notifications"`

预期：租约测试和两个 stdio 幂等测试全部通过。

- [x] **步骤 5：Commit**

```bash
git add apps/server/src/core/mcp-liveness.ts apps/server/src/test/mcp-liveness.test.ts
git commit -m "feat: handle MCP stdio disconnects"
```

### 任务 4：将 MCP server 绑定到连接租约

**文件：**
- 修改：`apps/server/src/mcp/server.ts`
- 修改：`apps/server/src/test/mcp-liveness.test.ts`

- [x] **步骤 1：增加 MCP metadata builder 的失败测试**

使用动态 import 测试 `mcp/server.ts` 暴露的纯函数，先固定自动注册必须包含连接 token、运行时和 PID：

```typescript
type McpServerApi = {
  buildMcpSessionMetadata?: (input: {
    connectionId: string;
    runtime: "claude" | "codex";
    pid: number | null;
    agentTag?: Record<string, unknown>;
    now?: Date;
  }) => Record<string, unknown>;
};

test("MCP session metadata includes the lease and runtime identity", async () => {
  const api = (await import("../mcp/server.js")) as unknown as McpServerApi;
  assert.equal(typeof api.buildMcpSessionMetadata, "function", "MCP metadata builder is not implemented");
  const now = new Date("2026-09-02T10:00:00.000Z");
  const metadata = api.buildMcpSessionMetadata!({
    connectionId: "builder-connection",
    runtime: "codex",
    pid: 7401,
    agentTag: { agent_id: 7 },
    now,
  });
  assert.equal(metadata.temp, true);
  assert.equal(metadata.runtime, "codex");
  assert.equal(metadata.runtime_pid, 7401);
  assert.equal(metadata.agent_id, 7);
  assert.equal(metadata.mcp_connection_id, "builder-connection");
  assert.equal(metadata.mcp_last_heartbeat_at, now.toISOString());
});
```

- [x] **步骤 2：运行测试确认红灯**

运行：`npm test -w apps/server -- --test-name-pattern="MCP session metadata"`

预期：失败，错误信息为 `MCP metadata builder is not implemented`。

- [x] **步骤 3：实现 builder、adoption 续租和 close 清理**

在 `mcp/server.ts` 增加 imports 和纯 builder，并移除原来仅用于通用会话探活的 `heartbeat` import：

```typescript
import {
  MCP_HEARTBEAT_INTERVAL_MS,
  claimMcpConnection,
  createMcpLeaseMetadata,
  installMcpStdioLifecycle,
  markMcpDisconnected,
  touchMcpConnection,
} from "../core/mcp-liveness.js";

export function buildMcpSessionMetadata(input: {
  connectionId: string;
  runtime: RuntimeId;
  pid: number | null;
  agentTag?: Record<string, unknown>;
  now?: Date;
}): Record<string, unknown> {
  return {
    temp: true,
    ...(input.agentTag ?? {}),
    runtime: input.runtime,
    ...(input.pid !== null ? { runtime_pid: input.pid } : {}),
    ...createMcpLeaseMetadata(input.connectionId, input.now),
  };
}
```

在 `runMcpServer()` 中按以下顺序接入：

```typescript
const connectionId = uuidv4();

registerSession(db, {
  id: sessionId,
  name: dirName,
  description: `${identity.runtime === "codex" ? "Codex" : "Claude Code"} session (auto-registered)`,
  project_dir: projectDir,
  identity_source: "mcp",
  metadata: buildMcpSessionMetadata({
    connectionId,
    runtime: identity.runtime,
    pid: identity.pid,
    agentTag,
  }),
});
```

在 `tryAdopt()` 中，成功切换 `sessionId` 后立即抢占同一个 token；当前 session 不切换时保留已注册 token：

```typescript
if (target.id === sessionId) return;
const oldId = sessionId;
sessionId = target.id;
deleteUnreferencedSession(db, oldId);
claimMcpConnection(db, sessionId, connectionId);
logger.info({ runtime: identity.runtime, runtimePid: pid, sessionId, oldId }, "mcp adopted hook-registered session");
```

将原来的 30 秒 `heartbeat()` 调用替换为租约续租；工具调用同样只调用 `touchMcpConnection()`，不能再绕过 token 直接调用通用 `heartbeat()`：

```typescript
const beat = setInterval(() => {
  try {
    tryAdopt();
    touchMcpConnection(db, sessionId, connectionId);
  } catch {
    // transient sqlite lock contention — next tick retries
  }
}, MCP_HEARTBEAT_INTERVAL_MS);
beat.unref();

// withAudit() starts with these two operations:
tryAdopt();
touchMcpConnection(db, sessionId, connectionId);
```

创建 `StdioServerTransport` 后、调用 `server.connect(transport)` 前安装清理；连接关闭只处理一次，旧 token 不会影响新连接：

```typescript
const transport = new StdioServerTransport();
let removeStdioLifecycle = () => {};
const disconnect = (reason: string) => {
  clearInterval(beat);
  removeStdioLifecycle();
  markMcpDisconnected(db, sessionId, connectionId, reason);
  if (db.open) db.close();
};
removeStdioLifecycle = installMcpStdioLifecycle(process.stdin, transport, disconnect);

try {
  await server.connect(transport);
} catch (err) {
  disconnect("connect-failed");
  throw err;
}
logger.info({ sessionId }, "mcp connected via stdio");
```

`installMcpStdioLifecycle()` 必须位于 `server.connect()` 之前，因为 MCP SDK 的 `Protocol.connect()` 会捕获并包装已有的 `transport.onclose`。

- [x] **步骤 4：运行 MCP 相关测试和构建确认绿灯**

运行：`npm test -w apps/server -- --test-name-pattern="MCP|liveness"` 和 `npm run build -w apps/server`

预期：MCP metadata、租约、stdio、PID 边界及既有服务器测试通过，TypeScript 构建退出码为 0。

- [x] **步骤 5：Commit**

```bash
git add apps/server/src/mcp/server.ts apps/server/src/test/mcp-liveness.test.ts
git commit -m "feat: bind MCP sessions to connection leases"
```

### 任务 5：接入 HTTP 租约过期扫描

**文件：**
- 修改：`apps/server/src/http/server.ts`
- 创建：`apps/server/src/test/http-liveness.test.ts`

- [x] **步骤 1：编写可注入探针的失败测试**

测试直接调用将要导出的 `reconcileRuntimeState()`，使用固定时间和 fake PID 探针，不等待真实 30 秒定时器：

```typescript
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { registerSession } from "../core/sessions.js";
import { createMcpLeaseMetadata } from "../core/mcp-liveness.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("HTTP liveness tick expires MCP leases without losing legacy PID reconcile", async () => {
  const http = (await import("../http/server.js")) as unknown as {
    reconcileRuntimeState?: (
      db: unknown,
      probe: () => Promise<{ claude: Set<number>; codex: Set<number> } | null>,
      now?: Date
    ) => Promise<{ expired: number; refreshed: number; reaped: number }>;
  };
  assert.equal(typeof http.reconcileRuntimeState, "function", "HTTP liveness tick is not implemented");

  const old = new Date("2026-09-02T10:00:00.000Z");
  const now = new Date("2026-09-02T10:01:31.000Z");
  registerSession(db, {
    id: "http-expiring-mcp",
    name: "http-expiring-mcp",
    metadata: {
      runtime: "codex",
      runtime_pid: 7501,
      ...createMcpLeaseMetadata("http-expiring-connection", old),
    },
  });
  registerSession(db, {
    id: "http-legacy-claude",
    name: "http-legacy-claude",
    metadata: { runtime: "claude", runtime_pid: 7502 },
  });

  const result = await http.reconcileRuntimeState!(
    db,
    async () => ({ claude: new Set([7502]), codex: new Set() }),
    now
  );
  assert.equal(result.expired, 1);
  assert.equal(
    (db.prepare("SELECT status FROM sessions WHERE id = ?").get("http-expiring-mcp") as { status: string }).status,
    "stale"
  );
  assert.equal(
    (db.prepare("SELECT status FROM sessions WHERE id = ?").get("http-legacy-claude") as { status: string }).status,
    "active"
  );
});
```

- [x] **步骤 2：运行测试确认红灯**

运行：`npm test -w apps/server -- --test-name-pattern="HTTP liveness tick"`

预期：失败，错误信息为 `HTTP liveness tick is not implemented`。

- [x] **步骤 3：抽出统一 liveness tick 并接入定时器**

在 `http/server.ts` 导入 `RuntimePidSnapshot` 和 `expireMcpLeases`，增加以下可测试函数；探针返回 `null` 时只跳过 PID reconcile，仍然执行 MCP TTL 回收：

```typescript
import {
  probeRuntimePids,
  reconcileRuntimeLiveness,
  type RuntimePidSnapshot,
} from "../core/liveness.js";
import { expireMcpLeases } from "../core/mcp-liveness.js";

export type RuntimePidProbe = () => Promise<RuntimePidSnapshot | null>;

export async function reconcileRuntimeState(
  db: DB,
  probe: RuntimePidProbe = probeRuntimePids,
  now: Date = new Date()
): Promise<{ expired: number; refreshed: number; reaped: number }> {
  const { expired } = expireMcpLeases(db, now);
  const livePids = await probe();
  if (!livePids) return { expired, refreshed: 0, reaped: 0 };
  const result = reconcileRuntimeLiveness(db, livePids, now);
  return { expired, ...result };
}
```

将原 `livenessTick()` 的内部实现替换为：

```typescript
const livenessTick = async () => {
  try {
    await reconcileRuntimeState(db);
  } catch {
    // transient — next tick retries
  }
};
```

定时器仍保持 30 秒间隔并调用 `unref()`；MCP 心跳不依赖 HTTP 定时器。

- [x] **步骤 4：运行 HTTP liveness 测试确认绿灯**

运行：`npm test -w apps/server -- --test-name-pattern="HTTP liveness tick|MCP lease|liveness"`

预期：过期 MCP 会话被回收，旧 Claude PID 会话仍被刷新，所有相关测试通过。

- [x] **步骤 5：Commit**

```bash
git add apps/server/src/http/server.ts apps/server/src/test/http-liveness.test.ts
git commit -m "feat: expire MCP leases from liveness tick"
```

### 任务 6：补充故障排查文档

**文件：**
- 修改：`docs/TROUBLESHOOTING.md`

- [x] **步骤 1：增加在线状态说明**

在现有 MCP/会话排查章节加入以下明确内容，避免用户把进程存在误解为窗口存活：

```markdown
### 会话在线状态

Conflux 中 MCP 会话显示“在线”表示当前 MCP stdio 连接仍在续租。Codex 或 Claude 的 CLI 进程仍存在，只能说明运行时进程存在，不能单独证明当前会话仍连接到 Conflux。

如果关闭终端后会话短时间仍显示在线，等待一次服务扫描；正常 stdin 断开会立即回收，强制结束或断电则在 MCP 租约 TTL 内回收。修改 MCP 配置后必须完全重启 Codex/Claude 宿主。

手动验证功能分支时，先关闭主工作树启动的 server 和旧 MCP，再从当前分支执行启动命令。否则正在运行的 `apps/server/dist/index.js` 可能来自另一份工作树，页面和数据库看到的行为不会对应当前源码。
```

- [x] **步骤 2：检查文档空白和提交**

运行：`git diff --check -- docs/TROUBLESHOOTING.md`

预期：无输出、退出码为 0。

```bash
git add docs/TROUBLESHOOTING.md
git commit -m "docs: explain MCP session presence"
```

### 任务 7：全量验证与分支运行检查

**文件：**
- 无新增代码文件；检查所有任务提交和工作树状态。

- [x] **步骤 1：运行服务器全量测试**

运行：`npm test -w apps/server`

预期：所有测试通过，退出码为 0。

- [x] **步骤 2：运行桌面与发布配置回归测试**

运行：`npm run test:desktop` 和 `node --test scripts/release-config.test.cjs`

预期：桌面测试和 release config 测试全部通过。

- [x] **步骤 3：运行全量构建（已执行，桌面打包环境阻塞已记录）**

运行：`npm run build` 和 `npm run build:desktop`

预期：shared、server、web 和 desktop 均构建成功，退出码为 0。

- [x] **步骤 4：检查改动范围与工作树**

运行：`git status --short --branch; git diff --check origin/feature/conflux-productization..HEAD`

预期：只有本计划列出的 Core、MCP、HTTP、测试和故障排查文档发生变化；没有生成数据库、日志或构建产物被加入 Git。

- [x] **步骤 5：手动验证当前分支的运行实例**

在不复用主工作树进程的前提下，从 `C:\Project folder\项目\muiltchat\.worktrees\conflux-productization` 执行：

```powershell
npm run build
npm run dev:desktop
```

验收顺序：

1. 从当前 Codex 窗口重新加载当前分支的 MCP 配置。
2. 确认 `/sessions?status=all` 中会话 metadata 包含 `mcp_connection_id` 和最新 `mcp_last_heartbeat_at`。
3. 保持 Codex idle，确认连续两次 HTTP 扫描后仍为 `active`，且 PID 快照是否出现不影响状态。
4. 完全关闭 Codex MCP 宿主，确认 stdin/transport close 后会话变为 `stale`，不等待完整 TTL。
5. 重新连接同一会话，确认旧连接的延迟 close 不会覆盖新 token。

- [x] **步骤 6：最终验证和交接**

运行：`git log --oneline -8; git status --short --branch`

预期：每个任务有独立 Conventional Commit，功能分支工作树干净；向用户报告实际命令、退出码和仍需手动验证的外部状态，不把主工作树旧进程当作本分支验证结果。

## 执行记录（2026-09-02）

- 服务端全量测试：`148 pass / 0 fail`。
- 桌面回归测试：`30 pass / 0 fail`；release 配置测试：`3 pass / 0 fail`。
- 根目录 `npm run build`：退出码 `0`。
- `npm run build:desktop`：前端资源构建成功；`electron-builder` 在 `better-sqlite3` 原生重编译阶段因当前路径包含空格且本机没有 Visual Studio C++ 工具链退出码 `1`。这项环境阻塞未改动源码。
- 当前分支 Electron 开发实例已启动并加载窗口；MCP 协议握手暴露 13 个工具。空闲 17 秒后租约心跳更新，stdin 关闭后会话由 `active/connected` 变为 `stale/disconnected`，原因 `transport-close`。
- 真实 Codex 宿主的 MCP 配置重载仍需用户侧完全重启 Codex 后确认；本次验证使用的是当前 worktree 的 MCP 子进程，不复用主工作树实例。

## 规格覆盖检查

| 规格要求 | 对应任务 |
| --- | --- |
| 唯一 MCP connection token 与 heartbeat | 任务 1、任务 4 |
| stdin/transport close 立即断开且幂等 | 任务 3、任务 4 |
| 新连接代际保护旧 close | 任务 1、任务 4 |
| 90 秒 TTL 与 30 秒 HTTP 扫描 | 任务 1、任务 5 |
| PID 不再正向刷新 MCP 租约 | 任务 2、任务 5 |
| 旧 Claude/无租约会话兼容 | 任务 2、任务 5、任务 7 |
| 错误处理与探针失败隔离 | 任务 1、任务 3、任务 5 |
| 故障排查文档与当前分支手动验收 | 任务 6、任务 7 |

## 计划自检

- 没有数据库表变更，metadata key 和函数签名在所有任务中保持一致。
- 测试先于对应生产代码；每个红灯命令都指出预期的缺失行为，每个绿灯命令都限定了验证范围。
- `mcp/server.ts` 在 `server.connect(transport)` 前安装 `onclose`，符合 MCP SDK 会包装已有 callback 的行为。
- HTTP 探针失败只跳过 PID reconcile，不跳过 MCP TTL 回收。
- 主工作树旧 server/MCP 进程的存在被作为手动验收前置条件记录，没有把它纳入本分支自动测试。
