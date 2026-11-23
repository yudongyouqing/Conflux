import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import type { ContextEntry, ContextKind } from "@conflux/shared";
import { publishLiveEvent } from "./event-bus.js";

export type { ContextEntry, ContextKind };

const VALID_KINDS = new Set<ContextKind>(["note", "decision", "artifact", "handoff"]);

export function normalizeContextKind(value: unknown): ContextKind {
  return typeof value === "string" && VALID_KINDS.has(value as ContextKind)
    ? (value as ContextKind)
    : "note";
}

export interface PublishInput {
  session_id: string;
  title: string;
  content: string;
  tags?: string[] | null;
  room_id?: number | null;
  kind?: ContextKind;
  pinned?: boolean;
}

interface ContextRow {
  id: number;
  session_id: string;
  title: string;
  content: string;
  tags: string | null;
  room_id?: number | null;
  kind?: string | null;
  pinned?: number | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: ContextRow): ContextEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    title: row.title,
    content: row.content,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
    room_id: row.room_id ?? null,
    kind: normalizeContextKind(row.kind),
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publishContext(db: DB, input: PublishInput): ContextEntry {
  const now = nowIso();
  const tags = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;
  const kind = normalizeContextKind(input.kind);
  const pinned = input.pinned ? 1 : 0;
  const roomId = input.room_id ?? null;
  const res = db
    .prepare(
      `INSERT INTO context_entries (session_id, title, content, tags, room_id, kind, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.session_id, input.title, input.content, tags, roomId, kind, pinned, now, now);
  const entry = getContext(db, Number(res.lastInsertRowid))!;
  publishLiveEvent({
    type: "context.updated",
    room_id: entry.room_id ?? null,
    session_id: entry.session_id,
    payload: { action: "published", entry_id: entry.id, kind: entry.kind, title: entry.title },
  });
  return entry;
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
  patch: {
    title?: string;
    content?: string;
    tags?: string[] | null;
    room_id?: number | null;
    kind?: ContextKind;
    pinned?: boolean;
  },
): ContextEntry | null {
  const existing = getContext(db, id);
  if (!existing) return null;
  if (existing.session_id !== ownerSessionId && ownerSessionId !== "web-console") {
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
  if (patch.room_id !== undefined) {
    sets.push("room_id = ?");
    params.push(patch.room_id);
  }
  if (patch.kind !== undefined) {
    sets.push("kind = ?");
    params.push(normalizeContextKind(patch.kind));
  }
  if (patch.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(patch.pinned ? 1 : 0);
  }
  if (sets.length === 0) return existing;
  sets.push("updated_at = ?");
  params.push(nowIso());
  params.push(id);
  db.prepare(`UPDATE context_entries SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  const updated = getContext(db, id)!;
  publishLiveEvent({
    type: "context.updated",
    room_id: updated.room_id ?? null,
    session_id: updated.session_id,
    payload: { action: "updated", entry_id: updated.id, kind: updated.kind, pinned: updated.pinned },
  });
  return updated;
}

export function deleteContext(db: DB, id: number, ownerSessionId: string): boolean {
  const existing = getContext(db, id);
  if (!existing) return false;
  if (existing.session_id !== ownerSessionId && ownerSessionId !== "web-console") {
    throw new Error("not owner of context entry");
  }
  db.prepare(`DELETE FROM context_entries WHERE id = ?`).run(id);
  publishLiveEvent({
    type: "context.updated",
    room_id: existing.room_id ?? null,
    session_id: existing.session_id,
    payload: { action: "deleted", entry_id: id },
  });
  return true;
}

export function listMyContext(db: DB, sessionId: string): ContextEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM context_entries WHERE session_id = ? ORDER BY pinned DESC, updated_at DESC`,
    )
    .all(sessionId) as ContextRow[];
  return rows.map(toEntry);
}

export function listRoomContext(db: DB, roomId: number, limit = 100): ContextEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM context_entries
       WHERE room_id = ?
       ORDER BY pinned DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(roomId, Math.min(Math.max(limit, 1), 500)) as ContextRow[];
  return rows.map(toEntry);
}
