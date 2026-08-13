import type { DB } from "./db.js";
import { nowIso } from "./db.js";

export interface ContextEntry {
  id: number;
  session_id: string;
  title: string;
  content: string;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface PublishInput {
  session_id: string;
  title: string;
  content: string;
  tags?: string[] | null;
}

interface ContextRow {
  id: number;
  session_id: string;
  title: string;
  content: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: ContextRow): ContextEntry {
  return {
    ...row,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
  };
}

export function publishContext(db: DB, input: PublishInput): ContextEntry {
  const now = nowIso();
  const tags = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;
  const res = db
    .prepare(
      `INSERT INTO context_entries (session_id, title, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.session_id, input.title, input.content, tags, now, now);
  return getContext(db, Number(res.lastInsertRowid))!;
}

export function getContext(db: DB, id: number): ContextEntry | null {
  const row = db.prepare(`SELECT * FROM context_entries WHERE id = ?`).get(id) as
    | ContextRow
    | undefined;
  return row ? toEntry(row) : null;
}

export function updateContext(
  db: DB,
  id: number,
  ownerSessionId: string,
  patch: { title?: string; content?: string; tags?: string[] | null }
): ContextEntry | null {
  const existing = getContext(db, id);
  if (!existing) return null;
  if (existing.session_id !== ownerSessionId) {
    throw new Error("not owner of context entry");
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.content !== undefined) {
    sets.push("content = ?");
    params.push(patch.content);
  }
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    params.push(patch.tags && patch.tags.length > 0 ? JSON.stringify(patch.tags) : null);
  }
  if (sets.length === 0) return existing;
  sets.push("updated_at = ?");
  params.push(nowIso());
  params.push(id);
  db.prepare(`UPDATE context_entries SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getContext(db, id);
}

export function deleteContext(db: DB, id: number, ownerSessionId: string): boolean {
  const existing = getContext(db, id);
  if (!existing) return false;
  if (existing.session_id !== ownerSessionId) {
    throw new Error("not owner of context entry");
  }
  db.prepare(`DELETE FROM context_entries WHERE id = ?`).run(id);
  return true;
}

export function listMyContext(db: DB, sessionId: string): ContextEntry[] {
  const rows = db
    .prepare(`SELECT * FROM context_entries WHERE session_id = ? ORDER BY updated_at DESC`)
    .all(sessionId) as ContextRow[];
  return rows.map(toEntry);
}
