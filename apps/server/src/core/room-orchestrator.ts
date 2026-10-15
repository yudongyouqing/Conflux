import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { getSession } from "./sessions.js";
import { logger } from "../log.js";
import { launchWakeRun } from "./wake/launcher.js";
import { planClaudeWake } from "./wake/claude.js";
import { getTerminalSettings } from "./app-settings.js";
import { badge, flattenOneLine } from "./inject-format.js";
import { tmuxInject } from "./wake/tmux-inject.js";
import { roomMembers, getChatRoom } from "./chat-rooms.js";
import { askAndMaybeWake } from "./ask.js";

/**
 * Room orchestration engine (#152): agents coordinate through a shared room
 * database. The core loop is:
 *
 *   1. An initiator (human or agent) calls room_summon(agent, prompt)
 *   2. A room_task row is created; the executor is woken/injected
 *   3. The executor processes with its own tools, calls room_write(result)
 *   4. When all expected tasks are done, the initiator is summoned back
 *      to read the results
 *
 * Cascade: an executor can itself call room_summon mid-execution, creating
 * sub-tasks. The room tracks the full dependency tree.
 */

export interface RoomTask {
  id: number;
  room_id: number;
  initiator_session_id: string;
  executor_session_id: string;
  prompt: string;
  status: "pending" | "running" | "done" | "failed";
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

// ---- task CRUD ---------------------------------------------------------------

export function createTask(
  db: DB,
  input: {
    room_id: number;
    initiator_session_id: string;
    executor_session_id: string;
    prompt: string;
  },
): RoomTask {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO room_tasks (room_id, initiator_session_id, executor_session_id, prompt, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(input.room_id, input.initiator_session_id, input.executor_session_id, input.prompt, now);
  return getTask(db, Number(res.lastInsertRowid))!;
}

export function getTask(db: DB, id: number): RoomTask | null {
  const row = db.prepare(`SELECT * FROM room_tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toTask(row) : null;
}

function toTask(r: Record<string, unknown>): RoomTask {
  return {
    id: r.id as number,
    room_id: r.room_id as number,
    initiator_session_id: r.initiator_session_id as string,
    executor_session_id: r.executor_session_id as string,
    prompt: r.prompt as string,
    status: r.status as RoomTask["status"],
    result: (r.result as string) ?? null,
    created_at: r.created_at as string,
    completed_at: (r.completed_at as string) ?? null,
  };
}

// ---- orchestration operations ------------------------------------------------

/**
 * Summon an agent: create a task, inject the prompt into the executor's
 * real process. The executor will call room_write when done.
 */
export function summonAgent(
  db: DB,
  input: {
    room_id: number;
    initiator_session_id: string;
    executor_session_id: string;
    prompt: string;
  },
): { task: RoomTask; injected: boolean; method: string } {
  const task = createTask(db, input);

  // Try live injection first, fall back to headless wake
  const injected = injectIntoProcess(db, input.executor_session_id, input.prompt, task.id);
  let method = injected ? "tmux" : "";

  if (!injected) {
    // Fallback: headless wake the agent to process the task
    const woke = headlessWakeForTask(db, input.executor_session_id, input.prompt, task.id);
    method = woke ? "headless" : "failed";
  }

  logger.info(
    { roomId: input.room_id, taskId: task.id, executor: input.executor_session_id, method },
    "room: agent summoned",
  );
  return { task, injected: method !== "failed", method };
}

/**
 * Write a result: mark task done, check if all expected tasks are complete,
 * if so summon the initiator back to read results.
 */
export function writeResult(
  db: DB,
  input: { task_id: number; executor_session_id: string; result: string },
): { task: RoomTask; allDone: boolean; summonedInitiator: boolean } {
  const task = getTask(db, input.task_id);
  if (!task) throw new Error(`task not found: ${input.task_id}`);
  if (task.executor_session_id !== input.executor_session_id) {
    throw new Error("not the executor of this task");
  }

  db.prepare(
    `UPDATE room_tasks SET status = 'done', result = ?, completed_at = ? WHERE id = ?`,
  ).run(input.result, nowIso(), input.task_id);

  const updated = getTask(db, input.task_id)!;

  // Check completion: all tasks in this room initiated by this initiator
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM room_tasks
       WHERE room_id = ? AND initiator_session_id = ? AND status IN ('pending', 'running')`,
    )
    .get(task.room_id, task.initiator_session_id) as { n: number };

  const allDone = pending.n === 0;
  let summonedInitiator = false;

  if (allDone) {
    // Summon the initiator to read results
    summonedInitiator = notifyInitiator(
      db,
      task.room_id,
      task.initiator_session_id,
      input.task_id,
    );
  }

  return { task: updated, allDone, summonedInitiator };
}

/**
 * Read all shared content in a room — room_tasks IS the shared thread.
 */
export function readRoom(db: DB, roomId: number) {
  const tasks = db
    .prepare(`SELECT * FROM room_tasks WHERE room_id = ? ORDER BY created_at ASC`)
    .all(roomId) as Record<string, unknown>[];
  return {
    tasks: tasks.map(toTask),
  };
}

/**
 * Room status: how many tasks pending/running/done, per executor.
 */
export function roomStatus(db: DB, roomId: number) {
  const rows = db
    .prepare(
      `SELECT executor_session_id, status, COUNT(*) AS n
       FROM room_tasks WHERE room_id = ?
       GROUP BY executor_session_id, status`,
    )
    .all(roomId) as { executor_session_id: string; status: string; n: number }[];
  return rows;
}

// ---- broadcast self-select (#151) ----------------------------------------------

export interface BroadcastResult {
  room_id: number;
  /** members actually addressed (sender excluded) */
  members: string[];
  /** created message ids, parallel to members */
  message_ids: number[];
}

/**
 * Broadcast a prompt to every room member except the sender: each member
 * gets the question via askAndMaybeWake (#163 typed delivery — badge +
 * full text into their terminal, or hook notice / wake as fallback) and
 * self-selects whether to answer. Replies come back through reply_ask and
 * stay visible in the room's shared thread (messages.room_id).
 */
export function broadcastToRoom(
  db: DB,
  input: { room_id: number; sender_session_id: string; prompt: string },
): BroadcastResult {
  const room = getChatRoom(db, input.room_id);
  if (!room) throw new Error(`room not found: ${input.room_id}`);

  const members = roomMembers(db, input.room_id).filter((m) => m !== input.sender_session_id);
  // self-select clause: silence must be an explicitly allowed answer, or
  // every member burns a turn replying "not me"
  const question =
    `${input.prompt}（聊天室「${room.name}」广播：适合你回答就用 Conflux 的 ` +
    `reply_ask 回复本条消息，回复会进房间共享线程；不适合则保持沉默，不要做其他事）`;

  const message_ids: number[] = [];
  for (const member of members) {
    try {
      const { message } = askAndMaybeWake(db, {
        from_session: input.sender_session_id,
        to_session: member,
        question,
        room_id: input.room_id,
      });
      message_ids.push(message.id);
    } catch (err) {
      // one unreachable member must not block the rest (priority gate etc.)
      logger.warn(
        { room: input.room_id, member, err: err instanceof Error ? err.message : String(err) },
        "broadcast: member skipped",
      );
    }
  }
  logger.info(
    { room: input.room_id, sender: input.sender_session_id, addressed: members.length },
    "room broadcast sent",
  );
  return { room_id: input.room_id, members, message_ids };
}

/**
 * The room's shared thread: broadcast questions and their replies
 * (messages.room_id), oldest first — the human-visible conversation.
 */
export function listRoomMessages(db: DB, roomId: number) {
  const rows = db
    .prepare(
      `SELECT m.id, m.room_id, m.from_session, m.to_session, m.question, m.reply, m.status, m.created_at,
              s1.name AS from_name, s2.name AS to_name
       FROM messages m
       LEFT JOIN sessions s1 ON s1.id = m.from_session
       LEFT JOIN sessions s2 ON s2.id = m.to_session
       WHERE m.room_id = ?
       ORDER BY m.id ASC`,
    )
    .all(roomId) as Array<{
    id: number;
    room_id: number;
    from_session: string;
    to_session: string;
    question: string;
    reply: string | null;
    status: string;
    created_at: string;
    from_name: string | null;
    to_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    room_id: r.room_id,
    from_session: r.from_session,
    to_session: r.to_session,
    from_name: r.from_name ?? r.from_session.slice(0, 8),
    to_name: r.to_name ?? r.to_session.slice(0, 8),
    question: r.question,
    reply: r.reply,
    status: r.status,
    created_at: r.created_at,
  }));
}

// ---- internals ---------------------------------------------------------------

/**
 * Fallback: headless wake the executor to process a room task (#152).
 * Uses the existing wake infrastructure (planClaudeWake → launchWakeRun)
 * with a prompt that tells the agent to process and room_write the result.
 */
function headlessWakeForTask(
  db: DB,
  sessionId: string,
  prompt: string,
  taskId: number,
): boolean {
  const session = getSession(db, sessionId);
  if (!session) return false;

  const runtime = session.runtime ?? "claude";
  if (runtime !== "claude") return false; // codex wake handled separately later

  const settings = getTerminalSettings(db);
  const exe = settings.claude_path || "claude";
  const offline = session.status !== "active";
  const plan = planClaudeWake({
    sessionId,
    exe,
    offline,
    projectDir: session.project_dir,
  });
  if ("refuse" in plan) return false;

  const wrapped = `${badge({ label: "聊天室任务", ref: `task #${taskId}` })} ${prompt}\n(这是一个聊天室任务。处理完后用 Conflux 的 room_write 工具写入结果，task_id=${taskId})`;
  const launch = launchWakeRun({
    db,
    sessionId,
    projectDir: session.project_dir,
    command: plan.command,
    prompt: wrapped,
    pinCodex: false,
  });
  if (!launch.ok) return false;

  db.prepare(`UPDATE room_tasks SET status = 'running' WHERE id = ?`).run(taskId);
  logger.info({ sessionId, taskId }, "room: headless wake launched");
  return true;
}

/** Try to inject prompt into live process; returns true if injected. */
function injectIntoProcess(
  db: DB,
  sessionId: string,
  prompt: string,
  taskId: number,
): boolean {
  const session = getSession(db, sessionId);
  if (!session) return false;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(session.metadata ?? "{}"); } catch { /* ignore */ }

  // Try tmux (Conflux-launched agents) — badged so the injected task is
  // distinguishable from human typing (#162)
  const agentId = Number(meta.agent_id);
  if (Number.isFinite(agentId) && agentId > 0) {
    const wrapped = `${badge({ label: "聊天室任务", ref: `task #${taskId}` })} ${flattenOneLine(
      prompt,
    )}（完成后用 Conflux 的 room_write 写入结果，task_id=${taskId}）`;
    if (tmuxInject(String(agentId), wrapped)) {
      db.prepare(`UPDATE room_tasks SET status = 'running' WHERE id = ?`).run(taskId);
      return true;
    }
  }
  return false;
}

/** Notify the initiator that all tasks are done. */
function notifyInitiator(
  db: DB,
  roomId: number,
  initiatorSessionId: string,
  _lastTaskId: number,
): boolean {
  if (initiatorSessionId === "web-console") {
    // Human initiator — OS notification handles this
    return true;
  }
  // Agent initiator — inject a "come read results" prompt
  const session = getSession(db, initiatorSessionId);
  if (!session) return false;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(session.metadata ?? "{}"); } catch { /* ignore */ }
  const agentId = Number(meta.agent_id);
  if (!Number.isFinite(agentId) || agentId <= 0) return false;

  const prompt = `${badge({ label: "任务完成通知" })} 你在聊天室的全部任务已完成。用 room_read 读取结果并继续。`;
  if (tmuxInject(String(agentId), prompt)) {
    logger.info({ roomId, initiatorSessionId }, "room: initiator summoned");
    return true;
  }
  return false;
}
