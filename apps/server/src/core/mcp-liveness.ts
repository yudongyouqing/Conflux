import type { DB } from "./db.js";

export const MCP_HEARTBEAT_INTERVAL_MS = 15_000;
export const MCP_LEASE_TTL_MS = 90_000;

export type McpConnectionState = "connected" | "disconnected";

export type StdioEventSource = {
  on(event: "end" | "close", listener: () => void): void;
  off(event: "end" | "close", listener: () => void): void;
};

export type StdioCloseableTransport = {
  close(): Promise<void>;
  onclose?: () => void;
};

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
  return (
    (db
      .prepare(`SELECT id, status, metadata, last_heartbeat_at FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined) ?? null
  );
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
  const result = db
    .prepare(
      `UPDATE sessions
          SET metadata = ?, status = 'active', last_heartbeat_at = ?
        WHERE ${metadataGuard(row)}`
    )
    .run(JSON.stringify(next), iso, ...guardArgs(row));
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
  const result = db
    .prepare(
      `UPDATE sessions
          SET metadata = ?, status = 'active', last_heartbeat_at = ?
        WHERE ${metadataGuard(row)}`
    )
    .run(JSON.stringify(next), iso, ...guardArgs(row));
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
  const result = db
    .prepare(
      `UPDATE sessions
          SET metadata = ?,
              status = CASE WHEN status = 'active' THEN 'stale' ELSE status END
        WHERE ${metadataGuard(row)}`
    )
    .run(JSON.stringify(next), ...guardArgs(row));
  return result.changes === 1;
}

export function expireMcpLeases(db: DB, now: Date = new Date()): { expired: number } {
  const rows = db
    .prepare(
      `SELECT id, status, metadata, last_heartbeat_at FROM sessions
        WHERE status = 'active' AND metadata LIKE '%"mcp_connection_id"%'`
    )
    .all() as SessionRow[];
  let expired = 0;
  for (const row of rows) {
    const metadata = readMetadata(row.metadata);
    if (!metadata) continue;
    if (!hasMcpConnection(metadata) || metadata.mcp_connection_state !== "connected") {
      continue;
    }
    const last =
      typeof metadata.mcp_last_heartbeat_at === "string"
        ? Date.parse(metadata.mcp_last_heartbeat_at)
        : Date.parse(row.last_heartbeat_at);
    if (!Number.isFinite(last) || now.getTime() - last < MCP_LEASE_TTL_MS) continue;
    if (
      markMcpDisconnected(
        db,
        row.id,
        String(metadata.mcp_connection_id),
        "lease-expired",
        now
      )
    ) {
      expired++;
    }
  }
  return { expired };
}

export function installMcpStdioLifecycle(
  stdin: StdioEventSource,
  transport: StdioCloseableTransport,
  onClose: (reason: "transport-close" | "stdin-close-failed") => void
): () => void {
  let closeRequested = false;
  let closeReported = false;
  let disposed = false;
  const existingOnClose = transport.onclose;

  const reportClose = (reason: "transport-close" | "stdin-close-failed"): void => {
    if (disposed || closeReported) return;
    closeReported = true;
    onClose(reason);
  };

  const handleTransportClose = (): void => {
    try {
      existingOnClose?.();
    } finally {
      reportClose("transport-close");
    }
  };

  const handleStdinClose = (): void => {
    if (disposed || closeRequested) return;
    closeRequested = true;
    try {
      void transport.close().catch(() => {
        reportClose("stdin-close-failed");
      });
    } catch {
      reportClose("stdin-close-failed");
    }
  };

  transport.onclose = handleTransportClose;
  stdin.on("end", handleStdinClose);
  stdin.on("close", handleStdinClose);

  return (): void => {
    if (disposed) return;
    disposed = true;
    stdin.off("end", handleStdinClose);
    stdin.off("close", handleStdinClose);
    if (transport.onclose === handleTransportClose) {
      transport.onclose = existingOnClose;
    }
  };
}
