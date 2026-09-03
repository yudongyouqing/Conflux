import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { registerSession } from "../core/sessions.js";
import { createMcpLeaseMetadata } from "../core/mcp-liveness.js";

type RuntimePidSnapshot = {
  claude: Set<number>;
  codex: Set<number>;
};

type HttpLivenessApi = {
  reconcileRuntimeState?: (
    db: ReturnType<typeof makeDb>["db"],
    probe: () => Promise<RuntimePidSnapshot>,
    now: Date
  ) => Promise<{ expired: number; refreshed: number; reaped: number }>;
};

test("HTTP liveness expires MCP leases and reconciles legacy runtime PIDs", async (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const server = (await import("../http/server.js")) as unknown as HttpLivenessApi;
  assert.equal(typeof server.reconcileRuntimeState, "function");

  const connectedAt = new Date("2026-09-02T10:00:00.000Z");
  registerSession(db, {
    id: "old-mcp-lease",
    name: "old-mcp-lease",
    metadata: {
      runtime: "codex",
      runtime_pid: 7501,
      ...createMcpLeaseMetadata("old-mcp-connection", connectedAt),
    },
  });
  registerSession(db, {
    id: "legacy-claude",
    name: "legacy-claude",
    metadata: { runtime: "claude", runtime_pid: 7502 },
  });

  const result = await server.reconcileRuntimeState!(
    db,
    async () => ({ claude: new Set([7502]), codex: new Set() }),
    new Date("2026-09-02T10:01:31.000Z")
  );

  assert.equal(result.expired, 1);
  assert.equal(
    (db.prepare("SELECT status FROM sessions WHERE id = ?").get("old-mcp-lease") as { status: string })
      .status,
    "stale"
  );
  assert.equal(
    (db.prepare("SELECT status FROM sessions WHERE id = ?").get("legacy-claude") as { status: string })
      .status,
    "active"
  );
});
