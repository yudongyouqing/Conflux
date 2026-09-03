import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { registerSession } from "../core/sessions.js";

type StdioEventSource = {
  on(event: "end" | "close", listener: () => void): void;
  off(event: "end" | "close", listener: () => void): void;
};

type StdioCloseableTransport = {
  close(): Promise<void>;
  onclose?: () => void;
};

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
    stdin: StdioEventSource,
    transport: StdioCloseableTransport,
    onClose: (reason: string) => void
  ) => () => void;
};

type McpServerApi = {
  buildMcpSessionMetadata?: (input: {
    connectionId: string;
    runtime: "claude" | "codex";
    pid: number | null;
    agentTag?: Record<string, unknown>;
    now?: Date;
  }) => Record<string, unknown>;
  adoptMcpSession?: (
    currentSessionId: string,
    targetSessionId: string,
    claim: () => boolean,
    deletePrevious: (id: string) => void
  ) => { sessionId: string; adopted: boolean };
};

class FakeStdin implements StdioEventSource {
  private readonly listeners = new Map<string, Set<() => void>>();

  on(event: "end" | "close", listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: "end" | "close", listener: () => void): void {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(event);
  }

  emit(event: "end" | "close"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  listenerCount(event: "end" | "close"): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeTransport implements StdioCloseableTransport {
  closeCalls = 0;
  onclose?: () => void;

  constructor(private readonly closeError?: Error, private readonly invokeOnClose = true) {}

  close(): Promise<void> {
    this.closeCalls++;
    if (this.invokeOnClose) this.onclose?.();
    return this.closeError ? Promise.reject(this.closeError) : Promise.resolve();
  }

  emitClose(): void {
    this.onclose?.();
  }
}

async function loadApi(): Promise<Api> {
  try {
    return (await import("../core/mcp-liveness.js")) as unknown as Api;
  } catch {
    return {};
  }
}

async function loadMcpServerApi(): Promise<McpServerApi> {
  try {
    return (await import("../mcp/server.js")) as unknown as McpServerApi;
  } catch {
    return {};
  }
}

test("MCP server session metadata builder combines identity and lease metadata", async () => {
  const api = await loadMcpServerApi();
  assert.equal(
    typeof api.buildMcpSessionMetadata,
    "function",
    "MCP server metadata builder is not implemented"
  );

  const now = new Date("2026-09-02T10:00:00.000Z");
  const metadata = api.buildMcpSessionMetadata!({
    connectionId: "connection-builder",
    runtime: "codex",
    pid: 7401,
    agentTag: { agent_id: 7 },
    now,
  });

  assert.equal(metadata.temp, true);
  assert.equal(metadata.runtime, "codex");
  assert.equal(metadata.runtime_pid, 7401);
  assert.equal(metadata.agent_id, 7);
  assert.equal(metadata.mcp_connection_id, "connection-builder");
  assert.equal(metadata.mcp_last_heartbeat_at, now.toISOString());
});

test("failed MCP adoption claim keeps the current lease owner for a later retry", async () => {
  const api = await loadMcpServerApi();
  assert.equal(typeof api.adoptMcpSession, "function", "MCP adoption helper is not implemented");

  let claimAllowed = false;
  let claimCalls = 0;
  const deleted: string[] = [];
  const claim = () => {
    claimCalls++;
    return claimAllowed;
  };
  const deletePrevious = (id: string) => {
    deleted.push(id);
  };

  const firstAttempt = api.adoptMcpSession!(
    "mcp-temp-session",
    "ended-target",
    claim,
    deletePrevious
  );
  assert.deepEqual(firstAttempt, { sessionId: "mcp-temp-session", adopted: false });
  assert.equal(claimCalls, 1);
  assert.deepEqual(deleted, []);

  claimAllowed = true;
  const retry = api.adoptMcpSession!(
    firstAttempt.sessionId,
    "ended-target",
    claim,
    deletePrevious
  );
  assert.deepEqual(retry, { sessionId: "ended-target", adopted: true });
  assert.deepEqual(deleted, ["mcp-temp-session"]);
});

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

test("new MCP connection replaces an old generation without old close killing it", async (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);
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

test("silent MCP lease expires and records a disconnected state", async (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);
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

test("stdin end and close request transport close once and report transport close once", async (t) => {
  const stdin = new FakeStdin();
  const transport = new FakeTransport();
  const reasons: string[] = [];
  const api = await loadApi();
  assert.equal(
    typeof api.installMcpStdioLifecycle,
    "function",
    "stdio lifecycle API is not implemented"
  );

  const dispose = api.installMcpStdioLifecycle!(stdin, transport, (reason) => {
    reasons.push(reason);
  });
  t.after(() => {
    dispose();
    assert.equal(stdin.listenerCount("end"), 0);
    assert.equal(stdin.listenerCount("close"), 0);
  });

  stdin.emit("end");
  stdin.emit("close");
  await Promise.resolve();

  assert.equal(transport.closeCalls, 1);
  assert.deepEqual(reasons, ["transport-close"]);
});

test("successful stdin transport close reports stdin close without transport onclose", async (t) => {
  const stdin = new FakeStdin();
  const transport = new FakeTransport(undefined, false);
  const reasons: string[] = [];
  const api = await loadApi();
  assert.equal(
    typeof api.installMcpStdioLifecycle,
    "function",
    "stdio lifecycle API is not implemented"
  );

  const dispose = api.installMcpStdioLifecycle!(stdin, transport, (reason) => {
    reasons.push(reason);
  });
  t.after(() => {
    dispose();
    assert.equal(stdin.listenerCount("end"), 0);
    assert.equal(stdin.listenerCount("close"), 0);
  });

  stdin.emit("end");
  await Promise.resolve();

  assert.equal(transport.closeCalls, 1);
  assert.deepEqual(reasons, ["stdin-close"]);
});

test("transport onclose reports transport close once", async (t) => {
  const stdin = new FakeStdin();
  const transport = new FakeTransport();
  let existingCloseCalls = 0;
  transport.onclose = () => {
    existingCloseCalls++;
  };
  const reasons: string[] = [];
  const api = await loadApi();
  assert.equal(
    typeof api.installMcpStdioLifecycle,
    "function",
    "stdio lifecycle API is not implemented"
  );

  const dispose = api.installMcpStdioLifecycle!(stdin, transport, (reason) => {
    reasons.push(reason);
  });
  t.after(() => {
    dispose();
    assert.equal(stdin.listenerCount("end"), 0);
    assert.equal(stdin.listenerCount("close"), 0);
  });

  transport.emitClose();
  transport.emitClose();

  assert.equal(existingCloseCalls, 2);
  assert.deepEqual(reasons, ["transport-close"]);
});

test("rejected stdin transport close reports a close failure", async (t) => {
  const stdin = new FakeStdin();
  const transport = new FakeTransport(new Error("close failed"), false);
  const reasons: string[] = [];
  const api = await loadApi();
  assert.equal(
    typeof api.installMcpStdioLifecycle,
    "function",
    "stdio lifecycle API is not implemented"
  );

  const dispose = api.installMcpStdioLifecycle!(stdin, transport, (reason) => {
    reasons.push(reason);
  });
  t.after(dispose);

  stdin.emit("end");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(reasons, ["stdin-close-failed"]);
});
