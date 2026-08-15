import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { STALE_AFTER_MS } from "../config.js";
import type { Session, SessionSummary } from "@muiltchat/shared";

export type { Session, SessionSummary };

export interface RegisterInput {
  id: string;
  name: string;
  description?: string | null;
  project_dir?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function registerSession(db: DB, input: RegisterInput): Session {
  const now = nowIso();
  const meta = input.metadata ? JSON.stringify(input.metadata) : null;
  db.prepare(
    `INSERT INTO sessions (id, name, description, project_dir, status, created_at, last_heartbeat_at, metadata)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       project_dir = COALESCE(excluded.project_dir, sessions.project_dir),
       metadata = COALESCE(excluded.metadata, sessions.metadata),
       status = 'active',
       last_heartbeat_at = excluded.last_heartbeat_at`
  ).run(input.id, input.name, input.description ?? null, input.project_dir ?? null, now, now, meta);
  return getSession(db, input.id)!;
}

export function getSession(db: DB, id: string): Session | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  return (row as Session | undefined) ?? null;
}

export function heartbeat(db: DB, id: string): void {
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ?, status = 'active' WHERE id = ?`).run(
    nowIso(),
    id
  );
}

/** Update just the display name (used to sync /rename titles). */
export function renameSession(db: DB, id: string, name: string): void {
  db.prepare(`UPDATE sessions SET name = ? WHERE id = ?`).run(name, id);
}

/** Update the short "what is this session doing" blurb (prompt excerpt). */
export function setSessionDescription(db: DB, id: string, description: string): void {
  db.prepare(`UPDATE sessions SET description = ? WHERE id = ?`).run(description, id);
}

/**
 * Lazily mark sessions stale if their last heartbeat is older than STALE_AFTER_MS.
 * Cheap: one UPDATE per call. Called from list_sessions / query_context.
 */
export function markStaleSessions(db: DB, now: Date = new Date()): number {
  const threshold = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const res = db
    .prepare(`UPDATE sessions SET status = 'stale' WHERE status = 'active' AND last_heartbeat_at < ?`)
    .run(threshold);
  return res.changes;
}

export function listSessions(
  db: DB,
  opts: { status?: "active" | "stale" | "ended" | "all" } = {}
): SessionSummary[] {
  markStaleSessions(db);
  const status = opts.status ?? "active";
  // MCP placeholder (temp) nodes are UUID noise — hidden from every listing.
  const where =
    status === "all"
      ? `WHERE COALESCE(s.metadata, '') NOT LIKE '%"temp":true%'`
      : `WHERE s.status = ? AND COALESCE(s.metadata, '') NOT LIKE '%"temp":true%'`;
  const params: string[] = status === "all" ? [] : [status];
  const rows = db
    .prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM context_entries c WHERE c.session_id = s.id) AS context_count,
         (SELECT COUNT(*) FROM messages m WHERE m.to_session = s.id AND m.status = 'pending') AS pending_inbox
       FROM sessions s
       ${where}
       ORDER BY s.last_heartbeat_at DESC`
    )
    .all(...params) as SessionSummary[];
  return rows;
}

export function endSession(db: DB, id: string): void {
  db.prepare(`UPDATE sessions SET status = 'ended' WHERE id = ?`).run(id);
}
