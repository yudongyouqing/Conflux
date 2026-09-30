import type { DB } from "./db.js";
import { nowIso } from "./db.js";

/**
 * Structured collaboration rooms (#137): a chat room is a fixed-topology
 * workflow — named participants, ordered steps (who asks whom), mutual
 * exclusivity (a session belongs to at most one room). Free-mode
 * conversations are untouched; rooms are an additional structure layer.
 */

// Chat rooms are SCOPES, not pipelines (#137 simplify): a named group of
// sessions that can freely ask each other (existing ask_session). No
// sequential steps, no forced flow — just a boundary.

export interface ChatRoom {
  id: number;
  name: string;
  description: string | null;
  /** member session ids — free-form conversations happen via existing ask_session */
  members: string[];
  created_at: string;
  updated_at: string;
}

interface ChatRoomRow {
  id: number;
  name: string;
  description: string | null;
  topology: string; // legacy column; stores member list JSON
  created_at: string;
  updated_at: string;
}

function toRoom(row: ChatRoomRow): ChatRoom {
  // legacy topology JSON → member list (unique session ids)
  let members: string[] = [];
  try {
    const parsed = JSON.parse(row.topology);
    if (Array.isArray(parsed)) {
      const ids = new Set<string>();
      for (const step of parsed as { from?: string; to?: string }[]) {
        if (typeof step.from === "string") ids.add(step.from);
        if (typeof step.to === "string") ids.add(step.to);
      }
      members = [...ids];
    }
  } catch { /* empty topology */ }
  return { id: row.id, name: row.name, description: row.description, members, created_at: row.created_at, updated_at: row.updated_at };
}

export function createChatRoom(
  db: DB,
  input: { name: string; description?: string; members: string[] },
): ChatRoom {
  if (!input.name.trim()) throw new Error("room name required");
  if (input.members.length < 2) throw new Error("at least 2 members required");
  const now = nowIso();
  // store members as the legacy topology column (array of {from,to} pairs for
  // schema compat — every member pairs with the first for storage)
  const legacyTopology = input.members.map((sid, i) => ({
    from: input.members[0],
    to: sid,
    order: i + 1,
  })).filter((s) => s.from !== s.to);
  const res = db
    .prepare(
      `INSERT INTO chat_rooms (name, description, topology, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.name.trim(), input.description ?? null, JSON.stringify(legacyTopology), now, now);
  const row = db
    .prepare(`SELECT * FROM chat_rooms WHERE id = ?`)
    .get(Number(res.lastInsertRowid)) as ChatRoomRow;
  // claim members (mutual exclusivity)
  for (const sid of input.members) {
    db.prepare(`UPDATE sessions SET chat_room_id = ? WHERE id = ?`).run(row.id, sid);
  }
  return toRoom(row);
}

export function listChatRooms(db: DB): ChatRoom[] {
  const rows = db.prepare(`SELECT * FROM chat_rooms ORDER BY updated_at DESC`).all() as ChatRoomRow[];
  return rows.map(toRoom);
}

export function getChatRoom(db: DB, id: number): ChatRoom | null {
  const row = db.prepare(`SELECT * FROM chat_rooms WHERE id = ?`).get(id) as ChatRoomRow | undefined;
  return row ? toRoom(row) : null;
}

export function deleteChatRoom(db: DB, id: number): boolean {
  // release members
  db.prepare(`UPDATE sessions SET chat_room_id = NULL WHERE chat_room_id = ?`).run(id);
  const res = db.prepare(`DELETE FROM chat_rooms WHERE id = ?`).run(id);
  return res.changes > 0;
}

/** Sessions in a room — authoritative source is sessions.chat_room_id. */
export function roomMembers(db: DB, roomId: number): string[] {
  const rows = db
    .prepare('SELECT id FROM sessions WHERE chat_room_id = ?')
    .all(roomId) as { id: string }[];
  return rows.map((r) => r.id);
}
