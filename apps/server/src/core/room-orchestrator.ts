import { execFileSync } from "node:child_process";
import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { getSession } from "./sessions.js";
import { logger } from "../log.js";
import { launchWakeRun } from "./wake/launcher.js";
import { planClaudeWake } from "./wake/claude.js";
import { wakeCommand, AUTO_WAKE_PROMPT } from "./wake/commands.js";
import { probeRuntimePids } from "./liveness.js";
import { getTerminalSettings } from "./app-settings.js";

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

  const wrapped = `${prompt}\n(这是一个聊天室任务。处理完后用 Conflux 的 room_write 工具写入结果，task_id=${taskId})`;
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

  // Try tmux (Conflux-launched agents)
  const agentId = Number(meta.agent_id);
  if (Number.isFinite(agentId) && agentId > 0) {
    try {
      const name = `conflux/agent-${agentId}`;
      execFileSync("tmux", ["has-session", "-t", name], { timeout: 2000, stdio: "ignore" });
      const wrapped = `${prompt}\n(完成后用 Conflux 的 room_write 写入结果，task_id=${taskId})`;
      execFileSync("tmux", ["send-keys", "-t", name, "-l", wrapped], { timeout: 3000, stdio: "ignore" });
      execFileSync("tmux", ["send-keys", "-t", name, "Enter"], { timeout: 3000, stdio: "ignore" });
      db.prepare(`UPDATE room_tasks SET status = 'running' WHERE id = ?`).run(taskId);
      return true;
    } catch { /* tmux not available */ }
  }
  return false;
}

/** Notify the initiator that all tasks are done. */
function notifyInitiator(
  db: DB,
  roomId: number,
  initiatorSessionId: string,
  lastTaskId: number,
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

  try {
    const name = `conflux/agent-${agentId}`;
    execFileSync("tmux", ["has-session", "-t", name], { timeout: 2000, stdio: "ignore" });
    const prompt = `你在聊天室的全部任务已完成。用 room_read 读取结果并继续。`;
    execFileSync("tmux", ["send-keys", "-t", name, "-l", prompt], { timeout: 3000, stdio: "ignore" });
    execFileSync("tmux", ["send-keys", "-t", name, "Enter"], { timeout: 3000, stdio: "ignore" });
    logger.info({ roomId, initiatorSessionId }, "room: initiator summoned");
    return true;
  } catch { return false; }
}
