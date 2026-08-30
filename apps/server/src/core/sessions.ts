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
  // Active MCP placeholders represent live Codex/Claude sessions. Hide only
  // stale or ended placeholders, which are UUID noise after their process exits.
  const tempVisibility = `(COALESCE(s.metadata, '') NOT LIKE '%"temp":true%' OR s.status = 'active')`;
  const where =
    status === "all"
      ? `WHERE ${tempVisibility}`
      : `WHERE s.status = ? AND ${tempVisibility}`;
  const params: string[] = status === "all" ? [] : [status];
  const rows = db
    .prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM context_entries c WHERE c.session_id = s.id) AS context_count,
         (SELECT COUNT(*) FROM messages m WHERE m.to_session = s.id AND m.status IN ('pending','seen')) AS pending_inbox
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

// ---- zero-turn session reaping ---------------------------------------------

/**
 * Claude Code assigns a fresh conversation id on every start / /resume /
 * /clear and fires SessionStart for it — so opening a terminal and immediately
 * /resume-ing away leaves a row that never received a single prompt. Those
 * rows (and MCP temp placeholders whose process died) are pure noise.
 *
 * A session is a zero-turn zombie iff ALL of:
 *   - never named: no `named:true` metadata (set on the first prompt event)
 *   - still on a default placeholder description, or an MCP temp node
 *   - nothing references it: no messages, no graph edges, no context entries
 *   - NOT a runtime-agent session (agent_id tag): those get their identity
 *     from a user-defined preset and may legitimately idle at the prompt
 *
 * Deleting them is lossless: if the conversation is ever resumed or asked,
 * the SessionStart hook recreates the row. Two sweep modes:
 *   - global (default): only rows already marked stale
 *   - { claudePid }: the same-process predecessors of the session currently
 *     being registered — the open-then-/resume case, cleaned up instantly
 *     (no stale wait needed: one process runs one conversation at a time).
 */
export function pruneAbandonedSessions(
  db: DB,
  opts: { claudePid?: number; keepId?: string } = {}
): number {
  const candidates = db
    .prepare(
      `SELECT id, status, metadata FROM sessions
       WHERE COALESCE(metadata, '') NOT LIKE '%"named":true%'
         AND COALESCE(metadata, '') NOT LIKE '%"agent_id":%'
         AND (
           description IN ('Claude Code session (hook)', 'Claude Code session (auto-registered)')
           OR COALESCE(metadata, '') LIKE '%"temp":true%'
         )`
    )
    .all() as { id: string; status: string; metadata: string | null }[];

  let deleted = 0;
  for (const row of candidates) {
    if (row.id === "web-console" || row.id === opts.keepId) continue;
    if (opts.claudePid !== undefined) {
      let meta: Record<string, unknown> = {};
      try {
        meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      } catch {
        // malformed metadata — treat as no pid, skip in pid mode
      }
      if (meta.claude_pid !== opts.claudePid) continue;
    } else if (row.status !== "stale") {
      continue;
    }
    // references re-checked at delete time (guarded, races lose harmlessly)
    const res = db
      .prepare(
        `DELETE FROM sessions WHERE id = ?
         AND (SELECT COUNT(*) FROM messages WHERE from_session = ? OR to_session = ?) = 0
         AND (SELECT COUNT(*) FROM edges WHERE from_session = ? OR to_session = ?) = 0
         AND (SELECT COUNT(*) FROM context_entries WHERE session_id = ?) = 0`
      )
      .run(row.id, row.id, row.id, row.id, row.id, row.id);
    deleted += res.changes;
  }
  return deleted;
}

/** Merge keys into a session's metadata JSON (in place, no full rewrite). */
export function mergeSessionMeta(db: DB, id: string, patch: Record<string, unknown>): void {
  const row = db.prepare(`SELECT metadata FROM sessions WHERE id = ?`).get(id) as
    | { metadata: string | null }
    | undefined;
  if (!row) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
  } catch {
    // corrupted metadata — start fresh rather than losing the patch
  }
  db.prepare(`UPDATE sessions SET metadata = ? WHERE id = ?`).run(
    JSON.stringify({ ...meta, ...patch }),
    id
  );
}
