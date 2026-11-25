import {
  WEB_CONSOLE_ID,
  type ManagedDeliveryMode,
  type Room,
  type RoomTask,
  type RoomTaskStatus,
} from "@conflux/shared";
import { nowIso, type DB } from "./db.js";
import { askThread } from "./messages.js";
import { getThread } from "./threads/store.js";
import { onThreadTurnFinalized } from "./threads/executor.js";
import { publishLiveEvent } from "./event-bus.js";

interface RoomRow {
  id: number;
  project_id: number | null;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface RoomTaskRow {
  id: number;
  room_id: number;
  initiator_thread_id: string;
  executor_thread_id: string;
  prompt: string;
  status: string;
  summary: string | null;
  message_id: number | null;
  created_at: string;
  updated_at: string;
}

function loadMembers(db: DB, roomId: number): string[] {
  return (
    db
      .prepare(`SELECT thread_id FROM room_members WHERE room_id = ? ORDER BY joined_at ASC`)
      .all(roomId) as Array<{ thread_id: string }>
  ).map((r) => r.thread_id);
}

function toRoom(db: DB, row: RoomRow): Room {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    description: row.description,
    members: loadMembers(db, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRoomTask(row: RoomTaskRow): RoomTask {
  return {
    id: row.id,
    room_id: row.room_id,
    initiator_thread_id: row.initiator_thread_id,
    executor_thread_id: row.executor_thread_id,
    prompt: row.prompt,
    status: row.status as RoomTaskStatus,
    summary: row.summary,
    message_id: row.message_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listRooms(db: DB, projectId?: number | null): Room[] {
  let rows: RoomRow[];
  if (projectId === undefined) {
    rows = db.prepare(`SELECT * FROM rooms ORDER BY updated_at DESC, id DESC`).all() as RoomRow[];
  } else if (projectId === null) {
    rows = db
      .prepare(`SELECT * FROM rooms WHERE project_id IS NULL ORDER BY updated_at DESC, id DESC`)
      .all() as RoomRow[];
  } else {
    rows = db
      .prepare(`SELECT * FROM rooms WHERE project_id = ? ORDER BY updated_at DESC, id DESC`)
      .all(projectId) as RoomRow[];
  }
  return rows.map((r) => toRoom(db, r));
}

export function getRoom(db: DB, id: number): Room | null {
  const row = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
  return row ? toRoom(db, row) : null;
}

export function createRoom(
  db: DB,
  input: { name: string; description?: string | null; project_id?: number | null; members?: string[] },
): Room {
  const name = input.name?.trim();
  if (!name) throw Object.assign(new Error("room name is required"), { statusCode: 400 });
  const now = nowIso();
  const room = db
    .transaction(() => {
      const res = db
        .prepare(
          `INSERT INTO rooms (project_id, name, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.project_id ?? null, name, input.description?.trim() || null, now, now);
      const roomId = Number(res.lastInsertRowid);
      for (const tid of input.members ?? []) {
        if (!getThread(db, tid)) continue;
        db.prepare(
          `INSERT OR IGNORE INTO room_members (room_id, thread_id, joined_at) VALUES (?, ?, ?)`,
        ).run(roomId, tid, now);
      }
      return getRoom(db, roomId)!;
    })
    .immediate();

  publishLiveEvent({
    type: "room.task",
    project_id: room.project_id,
    room_id: room.id,
    payload: { action: "room_created", room },
  });
  return room;
}

export function joinRoom(db: DB, roomId: number, threadId: string): Room {
  const room = getRoom(db, roomId);
  if (!room) throw Object.assign(new Error("room not found"), { statusCode: 404 });
  if (!getThread(db, threadId)) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
  db.prepare(
    `INSERT OR IGNORE INTO room_members (room_id, thread_id, joined_at) VALUES (?, ?, ?)`,
  ).run(roomId, threadId, nowIso());
  db.prepare(`UPDATE rooms SET updated_at = ? WHERE id = ?`).run(nowIso(), roomId);
  return getRoom(db, roomId)!;
}

export function leaveRoom(db: DB, roomId: number, threadId: string): Room | null {
  db.prepare(`DELETE FROM room_members WHERE room_id = ? AND thread_id = ?`).run(roomId, threadId);
  return getRoom(db, roomId);
}

export function deleteRoom(db: DB, id: number): boolean {
  return db.prepare(`DELETE FROM rooms WHERE id = ?`).run(id).changes > 0;
}

export function listRoomTasks(db: DB, roomId: number, limit = 50): RoomTask[] {
  const rows = db
    .prepare(`SELECT * FROM room_tasks WHERE room_id = ? ORDER BY id DESC LIMIT ?`)
    .all(roomId, Math.max(1, Math.min(limit, 200))) as RoomTaskRow[];
  return rows.map(toRoomTask);
}

export function getRoomTask(db: DB, id: number): RoomTask | null {
  const row = db.prepare(`SELECT * FROM room_tasks WHERE id = ?`).get(id) as RoomTaskRow | undefined;
  return row ? toRoomTask(row) : null;
}

/**
 * Two-way Room <-> Workbench summon:
 * Dispatches directly into the executor's full native Agent Thread (preserving all
 * project context & KV prompt cache prefix), creates a linked `room_tasks` row for
 * live status tracking in the room, and posts the final summary back on completion.
 */
export async function summonRoomAgent(
  db: DB,
  input: {
    room_id: number;
    executor_thread_id: string;
    prompt: string;
    initiator_thread_id?: string;
    delivery_mode?: ManagedDeliveryMode;
  },
): Promise<{ task: RoomTask; message_id: number; delivered: boolean; delivery_method: string }> {
  const room = getRoom(db, input.room_id);
  if (!room) throw Object.assign(new Error("room not found"), { statusCode: 404 });
  const executor = getThread(db, input.executor_thread_id);
  if (!executor) throw Object.assign(new Error("executor thread not found"), { statusCode: 404 });
  const initiator = input.initiator_thread_id || WEB_CONSOLE_ID;

  // Ensure executor is a member of this room.
  if (!room.members.includes(executor.id)) {
    joinRoom(db, room.id, executor.id);
  }

  const now = nowIso();
  const taskId = Number(
    db
      .prepare(
        `INSERT INTO room_tasks
         (room_id, initiator_thread_id, executor_thread_id, prompt, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(room.id, initiator, executor.id, input.prompt.trim(), now, now).lastInsertRowid,
  );

  const framedPrompt = `[房间「${room.name}」任务 #${taskId}]\n${input.prompt.trim()}`;
  const asked = await askThread(db, {
    from_thread: initiator,
    to_thread: executor.id,
    question: framedPrompt,
    room_id: room.id,
    delivery_mode: input.delivery_mode,
  });

  const nextStatus: RoomTaskStatus = asked.delivered ? "running" : "pending";
  db.prepare(`UPDATE room_tasks SET message_id = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    asked.message.id,
    nextStatus,
    nowIso(),
    taskId,
  );

  const task = getRoomTask(db, taskId)!;
  publishLiveEvent({
    type: "room.task",
    project_id: room.project_id,
    thread_id: executor.id,
    room_id: room.id,
    payload: { action: "summoned", task },
  });

  return {
    task,
    message_id: asked.message.id,
    delivered: asked.delivered,
    delivery_method: asked.delivery_method,
  };
}

export async function broadcastRoom(
  db: DB,
  input: { room_id: number; prompt: string; sender_thread_id?: string },
): Promise<{ room_id: number; dispatched: Array<{ thread_id: string; task_id: number; delivered: boolean }> }> {
  const room = getRoom(db, input.room_id);
  if (!room) throw Object.assign(new Error("room not found"), { statusCode: 404 });
  const sender = input.sender_thread_id || WEB_CONSOLE_ID;
  const targets = room.members.filter((id) => id !== sender);
  const dispatched: Array<{ thread_id: string; task_id: number; delivered: boolean }> = [];
  for (const tid of targets) {
    const res = await summonRoomAgent(db, {
      room_id: room.id,
      executor_thread_id: tid,
      prompt: input.prompt,
      initiator_thread_id: sender,
    });
    dispatched.push({ thread_id: tid, task_id: res.task.id, delivered: res.delivered });
  }
  return { room_id: room.id, dispatched };
}

export function reportRoomTaskDone(
  db: DB,
  taskId: number,
  summary: string,
  status: "done" | "failed" = "done",
): RoomTask | null {
  const existing = getRoomTask(db, taskId);
  if (!existing) return null;
  db.prepare(`UPDATE room_tasks SET status = ?, summary = ?, updated_at = ? WHERE id = ?`).run(
    status,
    summary,
    nowIso(),
    taskId,
  );
  const updated = getRoomTask(db, taskId)!;
  if (updated.message_id) {
    db.prepare(
      `UPDATE messages SET reply = COALESCE(reply, ?), status = 'replied', replied_at = COALESCE(replied_at, ?)
       WHERE id = ?`,
    ).run(summary, nowIso(), updated.message_id);
  }
  const room = getRoom(db, updated.room_id);
  publishLiveEvent({
    type: "room.task",
    project_id: room?.project_id ?? null,
    thread_id: updated.executor_thread_id,
    room_id: updated.room_id,
    payload: { action: "completed", task: updated },
  });
  return updated;
}

let roomHookInstalled = false;

/**
 * Connect ThreadManager turn completion back to Room tasks & Room chat stream
 * (two-way Room <-> Workbench synchronization).
 */
export function installRoomOrchestrationHooks(): void {
  if (roomHookInstalled) return;
  roomHookInstalled = true;
  onThreadTurnFinalized(({ db, messageId, roomId, state, finalText, errorCode, threadId }) => {
    if (!db.open || !messageId) return;
    const taskRow = db
      .prepare(
        `SELECT * FROM room_tasks WHERE message_id = ? AND status IN ('pending', 'running')`,
      )
      .get(messageId) as RoomTaskRow | undefined;
    if (taskRow) {
      const summary =
        state === "completed"
          ? finalText?.trim() || "（任务完成）"
          : state === "interrupted"
            ? "任务被中断"
            : `任务失败：${errorCode ?? "unknown"}`;
      reportRoomTaskDone(db, taskRow.id, summary, state === "completed" ? "done" : "failed");
    }
    if (roomId) {
      publishLiveEvent({
        type: "room.message",
        thread_id: threadId,
        room_id: roomId,
        payload: { phase: "replied", message_id: messageId, state, summary: finalText },
      });
    }
  });
}
