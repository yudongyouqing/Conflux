import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { recordEdge } from "./graph.js";
import type { Message, MessageStatus } from "@muiltchat/shared";

export type { Message, MessageStatus };

interface MessageRow {
  id: number;
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
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO messages (from_session, to_session, question, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    )
    .run(input.from_session, input.to_session, input.question, now);
  recordEdge(db, input.from_session, input.to_session);
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
  recordEdge(db, replierSessionId, msg.from_session);
  return getMessage(db, id)!;
}

export function checkInbox(db: DB, sessionId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE to_session = ? AND status = 'pending' ORDER BY created_at ASC`
    )
    .all(sessionId) as MessageRow[];
  return rows.map(toMsg);
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
