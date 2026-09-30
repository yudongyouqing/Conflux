import type { DB } from "./db.js";
import { nowIso } from "./db.js";

/**
 * Structured collaboration rooms (#137): a chat room is a fixed-topology
 * workflow — named participants, ordered steps (who asks whom), mutual
 * exclusivity (a session belongs to at most one room). Free-mode
 * conversations are untouched; rooms are an additional structure layer.
 */

export interface TopologyStep {
  from: string; // session id
  to: string;   // session id
  order: number;
}

export interface ChatRoom {
  id: number;
  name: string;
  description: string | null;
  topology: TopologyStep[];
  created_at: string;
  updated_at: string;
}

interface ChatRoomRow {
  id: number;
  name: string;
  description: string | null;
  topology: string;
  created_at: string;
  updated_at: string;
}

function toRoom(row: ChatRoomRow): ChatRoom {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    topology: JSON.parse(row.topology) as TopologyStep[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createChatRoom(
  db: DB,
  input: { name: string; description?: string; topology: TopologyStep[] },
): ChatRoom {
  if (!input.name.trim()) throw new Error("room name required");
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO chat_rooms (name, description, topology, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.name.trim(), input.description ?? null, JSON.stringify(input.topology), now, now);
  const row = db
    .prepare(`SELECT * FROM chat_rooms WHERE id = ?`)
    .get(Number(res.lastInsertRowid)) as ChatRoomRow;
  // claim members (mutual exclusivity: remove from any previous room)
  for (const step of input.topology) {
    for (const sid of [step.from, step.to]) {
      db.prepare(`UPDATE sessions SET chat_room_id = ? WHERE id = ?`).run(row.id, sid);
    }
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

/** Sessions in a room, with their step order for layout. */
export function roomMembers(db: DB, roomId: number): { id: string; stepOrder: number }[] {
  const rows = db
    .prepare(`SELECT id FROM sessions WHERE chat_room_id = ?`)
    .all(roomId) as { id: string }[];
  const room = getChatRoom(db, roomId);
  if (!room) return rows.map((r) => ({ id: r.id, stepOrder: 0 }));
  const orderMap = new Map<string, number>();
  for (const step of room.topology) {
    if (!orderMap.has(step.from)) orderMap.set(step.from, step.order);
    if (!orderMap.has(step.to)) orderMap.set(step.to, step.order);
  }
  return rows.map((r) => ({ id: r.id, stepOrder: orderMap.get(r.id) ?? 0 }));
}
