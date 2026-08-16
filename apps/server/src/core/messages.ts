import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { recordEdge, touchEdge } from "./graph.js";
import type { Message, MessageStatus } from "@muiltchat/shared";

export type { Message, MessageStatus };

interface MessageRow {
  id: number;
  edge_id: number | null;
  from_session: string;
  to_session: string;
  question: string;
  reply: string | null;
  status: MessageStatus;
  created_at: string;
  replied_at: string | null;
}

function toMsg(row: MessageRow): Message {
  return { ...row };
}

export function askSession(
  db: DB,
  input: { from_session: string; to_session: string; question: string }
): Message {
  if (input.from_session === input.to_session) {
    throw new Error("cannot ask yourself");
  }
  // target row may have been pruned (e.g. offline cleanup) — fail with a
  // clear error instead of a raw FOREIGN KEY violation
  const target = db
    .prepare(`SELECT id FROM sessions WHERE id = ?`)
    .get(input.to_session);
  if (!target) {
    throw new Error(`target session not found: ${input.to_session}`);
  }
  const now = nowIso();
  // the channel edge (from→to) IS the conversation: questions travel on it
  const edgeId = recordEdge(db, input.from_session, input.to_session);
  const res = db
    .prepare(
      `INSERT INTO messages (from_session, to_session, question, status, created_at, edge_id)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    )
    .run(input.from_session, input.to_session, input.question, now, edgeId);
  return getMessage(db, Number(res.lastInsertRowid))!;
}

export function getMessage(db: DB, id: number): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | MessageRow
    | undefined;
  return row ? toMsg(row) : null;
}

export function replyAsk(
  db: DB,
  id: number,
  replierSessionId: string,
  reply: string
): Message {
  const msg = getMessage(db, id);
  if (!msg) throw new Error("message not found");
  if (msg.to_session !== replierSessionId) {
    throw new Error("not the addressee of this message");
  }
  const now = nowIso();
  db.prepare(
    `UPDATE messages SET reply = ?, status = 'replied', replied_at = ? WHERE id = ?`
  ).run(reply, now, id);
  // the reply stays ON the channel — no reverse edge (direction is fixed:
  // the channel's from asked, its to answered)
  if (msg.edge_id !== null && msg.edge_id !== undefined) {
    touchEdge(db, msg.edge_id);
  } else {
    touchEdge(db, recordEdge(db, msg.from_session, msg.to_session));
  }
  return getMessage(db, id)!;
}

export function checkInbox(db: DB, sessionId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE to_session = ? AND status IN ('pending','seen') ORDER BY created_at ASC`
    )
    .all(sessionId) as MessageRow[];
  // Mark freshly-fetched pending messages as seen so the asker can tell
  // "read but not yet answered" from "never looked at". Unanswered items
  // stay in the inbox until replied.
  const fresh = rows.filter((r) => r.status === "pending");
  if (fresh.length > 0) {
    const ids = fresh.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE messages SET status = 'seen' WHERE status = 'pending' AND id IN (${placeholders})`
    ).run(...ids);
  }
  return rows.map((r) =>
    r.status === "pending" ? { ...toMsg(r), status: "seen" as const } : toMsg(r)
  );
}

export function checkReplies(
  db: DB,
  sessionId: string,
  since?: string
): Message[] {
  const sinceClause = since ? `AND replied_at > ?` : ``;
  const params: string[] = since ? [sessionId, since] : [sessionId];
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE from_session = ? AND status IN ('replied','read') ${sinceClause}
       ORDER BY replied_at DESC`
    )
    .all(...params) as MessageRow[];
  // Mark as read for next call.
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE messages SET status = 'read' WHERE status = 'replied' AND id IN (${placeholders})`
    ).run(...ids);
  }
  return rows.map(toMsg);
}

/**
 * Global message query with optional filters. Used by the frontend message-flow
 * viewer. Unlike checkInbox/checkReplies, this does NOT mutate status.
 */
/**
 * Archive an exchange that already happened out-of-band (e.g. Claude Code's
 * native SendMessage). The delivery is complete, so the row is written in
 * its terminal state — no pending/seen inbox noise — and both directions'
 * edges are recorded so the graph reflects the communication.
 */
export function recordExchange(
  db: DB,
  input: {
    from_session: string;
    to_session: string;
    question: string;
    reply?: string | null;
    /** ISO timestamp of when the exchange happened; default now. */
    occurred_at?: string;
  }
): Message {
  for (const id of [input.from_session, input.to_session]) {
    const row = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(id);
    if (!row) throw new Error(`session not found: ${id}`);
  }
  const occurred = input.occurred_at ?? nowIso();
  const status: MessageStatus = input.reply ? "replied" : "read";
  const res = db
    .prepare(
      `INSERT INTO messages (from_session, to_session, question, reply, status, created_at, replied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.from_session,
      input.to_session,
      input.question,
      input.reply ?? null,
      status,
      occurred,
      input.reply ? occurred : null
    );
  recordEdge(db, input.from_session, input.to_session);
  if (input.reply) recordEdge(db, input.to_session, input.from_session);
  return getMessage(db, Number(res.lastInsertRowid))!;
}

/**
 * Two-way message flow between two sessions (web console ↔ peer), oldest
 * first — used by the web Drawer conversation view.
 */
export function listPeerMessages(db: DB, a: string, b: string, limit = 200): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE (from_session = ? AND to_session = ?) OR (from_session = ? AND to_session = ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(a, b, b, a, Math.min(Math.max(limit, 1), 500)) as MessageRow[];
  return rows.map(toMsg).reverse();
}

export function listMessages(
  db: DB,
  opts: {
    from_session?: string;
    to_session?: string;
    status?: MessageStatus | "all";
    since?: string;
    limit?: number;
  } = {}
): Message[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.from_session) {
    where.push("from_session = ?");
    params.push(opts.from_session);
  }
  if (opts.to_session) {
    where.push("to_session = ?");
    params.push(opts.to_session);
  }
  if (opts.status && opts.status !== "all") {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.since) {
    where.push("created_at > ?");
    params.push(opts.since);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM messages ${whereSql} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as MessageRow[];
  return rows.map(toMsg);
}

// ---- inbox delivery across /resume + proactive notices ----------------------

/**
 * /resume continues the same conversation under a NEW conversation id, so
 * mail addressed to the process's previous ids would strand there forever
 * even though the conversation lives on. Re-address undelivered mail
 * (pending/seen) to the successor. Called from the session-start hook when
 * source === "resume"; a /clear'ed conversation is a DIFFERENT conversation
 * and must not be forwarded.
 */
export function forwardInboxFromPid(db: DB, claudePid: number, successorId: string): number {
  const rows = db
    .prepare(
      `SELECT id, metadata FROM sessions WHERE id != ? AND metadata LIKE ?`
    )
    .all(successorId, `%"claude_pid":${claudePid}%`) as { id: string; metadata: string | null }[];
  const ids = rows
    .filter((r) => {
      try {
        return (
          JSON.parse(r.metadata ?? "{}").claude_pid === claudePid
        );
      } catch {
        return false;
      }
    })
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const res = db
    .prepare(
      `UPDATE messages SET to_session = ?
       WHERE status IN ('pending','seen') AND to_session IN (${placeholders})`
    )
    .run(successorId, ...ids);
  return res.changes;
}

/**
 * Short stdout notice for hook events (UserPromptSubmit/SessionStart stdout
 * is injected into the conversation context). Returns null when there is
 * nothing unread — hooks must stay silent in the common case. Only
 * still-pending (never even seen) messages trigger a notice, so the nag
 * stops once the session actually runs check_inbox.
 */
export function formatInboxNotice(db: DB, sessionId: string): string | null {
  const rows = db
    .prepare(
      `SELECT m.question, s.name, substr(m.from_session, 1, 8) AS sid8
       FROM messages m LEFT JOIN sessions s ON s.id = m.from_session
       WHERE m.to_session = ? AND m.status = 'pending'
       ORDER BY m.id ASC`
    )
    .all(sessionId) as { question: string; name: string | null; sid8: string }[];
  if (rows.length === 0) return null;
  const first = rows[0];
  const excerpt = first.question.replace(/\s+/g, " ").slice(0, 60);
  const from = first.name ?? first.sid8;
  return (
    `[muiltchat] 收件箱有 ${rows.length} 条未读消息(最新来自「${from}」: ${excerpt}…)。` +
    `请调用 muiltchat 的 check_inbox 工具查看并 reply_ask 回复。`
  );
}

/**
 * The full exchange history of one conversation channel (edge), oldest
 * first — the edge-panel view.
 */
export function listEdgeMessages(db: DB, edgeId: number, limit = 200): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE edge_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(edgeId, Math.min(Math.max(limit, 1), 500)) as MessageRow[];
  return rows.map(toMsg).reverse();
}

/** Channel header for the edge panel. */
export function getEdge(
  db: DB,
  edgeId: number
): { id: number; from_session: string; to_session: string; weight: number; last_interact_at: string } | null {
  const row = db
    .prepare(
      `SELECT rowid AS id, from_session, to_session, weight, last_interact_at FROM edges WHERE rowid = ?`
    )
    .get(edgeId) as
    | { id: number; from_session: string; to_session: string; weight: number; last_interact_at: string }
    | undefined;
  return row ?? null;
}
