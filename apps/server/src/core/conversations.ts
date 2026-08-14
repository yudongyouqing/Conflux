import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import type { Conversation, Turn } from "@muiltchat/shared";

export type { Conversation, Turn };

export function createConversation(
  db: DB,
  input: { agent_id: number; initiated_by?: string | null; title?: string | null }
): Conversation {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO conversations (agent_id, initiated_by, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.agent_id, input.initiated_by ?? null, input.title ?? null, now, now);
  return getConversation(db, Number(res.lastInsertRowid))!;
}

export function getConversation(db: DB, id: number): Conversation | null {
  return (db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Conversation) ?? null;
}

export function listConversations(
  db: DB,
  opts: { agent_id?: number; limit?: number } = {}
): Conversation[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  if (opts.agent_id) {
    return db
      .prepare(`SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(opts.agent_id, limit) as Conversation[];
  }
  return db
    .prepare(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Conversation[];
}

export function addTurn(
  db: DB,
  input: { conversation_id: number; role: "user" | "assistant"; content: string }
): Turn {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO turns (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(input.conversation_id, input.role, input.content, now);
  // Bump conversation updated_at
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, input.conversation_id);
  return getTurns(db, input.conversation_id).find((t) => t.id === Number(res.lastInsertRowid))!;
}

export function getTurns(db: DB, conversationId: number): Turn[] {
  return db
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId) as Turn[];
}

export function deleteConversation(db: DB, id: number): boolean {
  const res = db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  return res.changes > 0;
}
