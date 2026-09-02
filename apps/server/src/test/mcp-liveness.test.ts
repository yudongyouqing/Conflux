import { test } from "node:test";
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
};

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
