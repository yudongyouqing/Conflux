import type { DB } from "./db.js";
import { isLockError, nowIso } from "./db.js";
import { WEB_CONSOLE_ID, type ManagedDeliveryMode } from "@conflux/shared";
import { getSession } from "./sessions.js";
import { logger } from "../log.js";
import { launchWakeRun } from "./wake/launcher.js";
import { agentPromptSuffix } from "./wake/index.js";
import { planClaudeWake } from "./wake/claude.js";
import { getTerminalSettings } from "./app-settings.js";
import { badge, flattenOneLine } from "./inject-format.js";
import { tmuxInject } from "./wake/tmux-inject.js";
import { roomMembers, getChatRoom } from "./chat-rooms.js";
import { prepareAsk, completeAsk, type AskPrepared } from "./ask.js";
import { askSession } from "./messages.js";
import { enqueueManagedTask, getManagedBindingBySession } from "./managed-codex/store.js";
import { getManagedExecutorForInstance } from "./managed/registry.js";
import { onManagedTurnFinalized } from "./managed/executor.js";
import { publishLiveEvent } from "./event-bus.js";
import { onWorkflowStepMessageCompleted } from "./workflows.js";

/**
 * Room orchestration engine: agents coordinate through a shared room
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
  task_token: string;
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
  // Generate a one-shot task token (32-char hex) for split-brain-free validation
  const task_token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const res = db
    .prepare(
      `INSERT INTO room_tasks (room_id, initiator_session_id, executor_session_id, task_token, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(input.room_id, input.initiator_session_id, input.executor_session_id, task_token, input.prompt, now);
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
    task_token: r.task_token as string,
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
  return completeSummon(db, input, prepareSummon(db, input));
}

/**
 * Phase 1 — DATABASE ONLY: the task row. Callers retrying the transaction
 * on lock contention (the HTTP server's ctx.write) must wrap ONLY this
 * phase; the delivery channels below cannot be rolled back.
 */
export function prepareSummon(
  db: DB,
  input: {
    room_id: number;
    initiator_session_id: string;
    executor_session_id: string;
    prompt: string;
  },
): RoomTask {
  return createTask(db, input);
}

/**
 * Phase 2 — EXTERNAL delivery (terminal injection / headless wake spawn),
 * strictly after phase 1 commits. Never inside a retried transaction.
 */
export function completeSummon(
  db: DB,
  input: {
    room_id: number;
    initiator_session_id: string;
    executor_session_id: string;
    prompt: string;
    delivery_mode?: ManagedDeliveryMode;
  },
  task: RoomTask,
): { task: RoomTask; injected: boolean; method: string } {
  // 1. Native managed executor (Claude / Codex / Antigravity / ACP) takes precedence
  //    over terminal tmux injection or headless wake so managed & external sessions
  //    coexist seamlessly in the same room.
  const managedBinding = getManagedBindingBySession(db, input.executor_session_id);
  if (managedBinding) {
    const wrapped = wrapRoomTaskPrompt(input.room_id, task.id, task.task_token, input.prompt);
    const executor = getManagedExecutorForInstance(db, managedBinding.instance_id);
    const deliveryMode = input.delivery_mode ?? "queue";

    if (deliveryMode === "steer" && executor) {
      const status = executor.instanceStatus(managedBinding.instance_id);
      if (status?.live && status.activeRun) {
        void executor
          .steer(managedBinding.instance_id, {
            text: wrapped,
            expectedTurnId: status.activeRun.turnId,
          })
          .catch(() => {});
        db.prepare(`UPDATE room_tasks SET status = 'running' WHERE id = ?`).run(task.id);
        publishLiveEvent({
          type: "room.task",
          room_id: input.room_id,
          session_id: input.executor_session_id,
          payload: { task_id: task.id, status: "running", method: "managed-steer" },
        });
        return { task: getTask(db, task.id) ?? task, injected: true, method: "managed-steer" };
      }
    }

    if (deliveryMode === "interrupt" && executor) {
      const status = executor.instanceStatus(managedBinding.instance_id);
      if (status?.live && status.activeRun) {
        void executor.interrupt(managedBinding.instance_id, status.activeRun.turnId).catch(() => {});
      }
    }

    const msg = askSession(db, {
      from_session: input.initiator_session_id,
      to_session: input.executor_session_id,
      question: wrapped,
      room_id: input.room_id,
    });
    enqueueManagedTask(db, {
      messageId: msg.id,
      instanceId: managedBinding.instance_id,
      text: wrapped,
    });
    db.prepare(`UPDATE room_tasks SET status = 'running', message_id = ? WHERE id = ?`).run(
      msg.id,
      task.id,
    );
    executor?.kick(managedBinding.instance_id);
    publishLiveEvent({
      type: "room.task",
      room_id: input.room_id,
      session_id: input.executor_session_id,
      payload: { task_id: task.id, status: "running", method: "managed", message_id: msg.id },
    });
    logger.info(
      { roomId: input.room_id, taskId: task.id, executor: input.executor_session_id, method: "managed" },
      "room: managed agent summoned",
    );
    return { task: getTask(db, task.id) ?? task, injected: true, method: "managed" };
  }

  // 2. External terminal session: try live tmux injection, fall back to headless wake.
  const injected = injectIntoProcess(db, input.executor_session_id, input.prompt, task.id, task.task_token, input.room_id);
  let method = injected ? "tmux" : "";

  if (!injected) {
    const woke = headlessWakeForTask(db, input.executor_session_id, input.prompt, task.id, task.task_token, input.room_id);
    method = woke ? "headless" : "failed";
  }

  publishLiveEvent({
    type: "room.task",
    room_id: input.room_id,
    session_id: input.executor_session_id,
    payload: { task_id: task.id, status: method === "failed" ? "pending" : "running", method },
  });

  logger.info(
    { roomId: input.room_id, taskId: task.id, executor: input.executor_session_id, method },
    "room: agent summoned",
  );
  return { task, injected: method !== "failed", method };
}

/**
 * Write a result: mark task done, check if all expected tasks are complete,
 * if so summon the initiator back to read results.
 * Now uses task_token for split-brain-free validation instead of executor_session_id.
 */
export function writeResult(
  db: DB,
  input: { task_id: number; task_token: string; result: string },
): { task: RoomTask; allDone: boolean; summonedInitiator: boolean } {
  const { updated, allDone } = db
    .transaction(() => {
      const task = getTask(db, input.task_id);
      if (!task) {
        throw Object.assign(new Error(`task not found: ${input.task_id}`), { statusCode: 404 });
      }
      if (task.task_token !== input.task_token) {
        throw Object.assign(new Error("invalid task token"), { statusCode: 403 });
      }
      if (task.status === "done" || task.status === "failed") {
        throw Object.assign(new Error(`task already finalized: ${task.status}`), {
          statusCode: 409,
        });
      }

      const res = db
        .prepare(
          `UPDATE room_tasks SET status = 'done', result = ?, completed_at = ?
           WHERE id = ? AND status IN ('pending', 'running')`,
        )
        .run(input.result, nowIso(), input.task_id);
      if (res.changes === 0) {
        throw Object.assign(new Error("task already finalized"), { statusCode: 409 });
      }

      const doneTask = getTask(db, input.task_id)!;

      // Check completion: all tasks in this room initiated by this initiator
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS n FROM room_tasks
           WHERE room_id = ? AND initiator_session_id = ? AND status IN ('pending', 'running')`,
        )
        .get(doneTask.room_id, doneTask.initiator_session_id) as { n: number };

      return { updated: doneTask, allDone: pending.n === 0 };
    })
    .immediate();

  let summonedInitiator = false;
  if (allDone) {
    // Summon the initiator to read results (external I/O strictly after commit)
    summonedInitiator = notifyInitiator(db, updated.room_id, updated.initiator_session_id);
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

// ---- broadcast self-select ----------------------------------------------

export interface BroadcastResult {
  room_id: number;
  /** members actually addressed (sender excluded) */
  members: string[];
  /** created message ids, parallel to members */
  message_ids: number[];
}

/**
 * Broadcast a prompt to every room member except the sender: each member
 * gets the question via askAndMaybeWake (typed delivery — badge +
 * full text into their terminal, or hook notice / wake as fallback) and
 * self-selects whether to answer. Replies come back through reply_ask and
 * stay visible in the room's shared thread (messages.room_id).
 */
export async function broadcastToRoom(
  db: DB,
  input: { room_id: number; sender_session_id: string; prompt: string },
): Promise<BroadcastResult> {
  return completeBroadcast(db, input, prepareBroadcast(db, input));
}

/**
 * Phase 1 — DATABASE ONLY: room/member reads, the self-select question
 * insert and the per-member delivery claims. Safe to retry as a whole.
 */
export interface BroadcastPrepared {
  members: string[];
  question: string;
  prepared: AskPrepared[];
}

export function prepareBroadcast(
  db: DB,
  input: { room_id: number; sender_session_id: string; prompt: string },
): BroadcastPrepared {
  return db
    .transaction(() => {
      const room = getChatRoom(db, input.room_id);
      if (!room) {
        throw Object.assign(new Error(`room not found: ${input.room_id}`), { statusCode: 404 });
      }

      const candidates = roomMembers(db, input.room_id).filter(
        (m) => m !== input.sender_session_id,
      );
      // self-select clause: silence must be an explicitly allowed answer, or
      // every member burns a turn replying "not me"
      const question =
        `${input.prompt}（聊天室「${room.name}」广播：适合你回答就用 Conflux 的 ` +
        `reply_ask 回复本条消息，回复会进房间共享线程；不适合则保持沉默，不要做其他事）`;

      const addressedMembers: string[] = [];
      const prepared: AskPrepared[] = [];
      for (const member of candidates) {
        try {
          prepared.push(
            prepareAsk(db, {
              from_session: input.sender_session_id,
              to_session: member,
              question,
              room_id: input.room_id,
            }),
          );
          addressedMembers.push(member);
        } catch (err) {
          if (isLockError(err)) throw err;
          // one unreachable member must not block the rest (priority gate etc.)
          logger.warn(
            {
              room: input.room_id,
              member,
              err: err instanceof Error ? err.message : String(err),
            },
            "broadcast: member skipped",
          );
        }
      }
      return { members: addressedMembers, question, prepared };
    })
    .immediate();
}

/**
 * Phase 2 — EXTERNAL per-member wakes / typed pushes, strictly after the
 * commit of phase 1. Never inside a retried transaction.
 */
export async function completeBroadcast(
  db: DB,
  input: { room_id: number; sender_session_id: string; prompt: string },
  preparedBroadcast: BroadcastPrepared,
): Promise<BroadcastResult> {
  const members: string[] = [];
  const message_ids: number[] = [];
  for (const prepared of preparedBroadcast.prepared) {
    try {
      const outcome = await completeAsk(db, prepared);
      members.push(prepared.message.to_session);
      message_ids.push(outcome.message.id);
    } catch (err) {
      logger.warn(
        { room: input.room_id, member: prepared.message.to_session, err: err instanceof Error ? err.message : String(err) },
        "broadcast: member delivery failed",
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
 * The prompt every room-task delivery channel shares. room_id lets the
 * executor room_read its context once its MCP lands on the orchestrator's
 * database; the token is one-shot write authorization for the task row.
 */
export function wrapRoomTaskPrompt(
  roomId: number,
  taskId: number,
  taskToken: string,
  prompt: string,
): string {
  return (
    `${badge({ label: "聊天室任务", ref: `task #${taskId}` })} ${prompt}\n` +
    `(这是一个聊天室任务，room_id=${roomId}。处理完后用 Conflux 的 room_write 工具写入结果，` +
    `task_id=${taskId}，task_token="${taskToken}")`
  );
}

/**
 * Fallback: headless wake the executor to process a room task.
 * Uses the existing wake infrastructure (planClaudeWake → launchWakeRun)
 * with a prompt that tells the agent to process and room_write the result.
 */
function headlessWakeForTask(
  db: DB,
  sessionId: string,
  prompt: string,
  taskId: number,
  taskToken: string,
  roomId: number,
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

  const wrapped = wrapRoomTaskPrompt(roomId, taskId, taskToken, prompt);
  // Agent sessions must resume with their --append-system-prompt or
  // the system block changes and the whole cached prefix is lost
  let meta: Record<string, unknown> | null = null;
  try { meta = session.metadata ? (JSON.parse(session.metadata) as Record<string, unknown>) : null; } catch { /* ignore */ }
  const launch = launchWakeRun({
    db,
    sessionId,
    projectDir: session.project_dir,
    command: plan.command + agentPromptSuffix(db, meta),
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
  taskToken: string,
  roomId: number,
): boolean {
  const session = getSession(db, sessionId);
  if (!session) return false;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(session.metadata ?? "{}"); } catch { /* ignore */ }

  // Try tmux (Conflux-launched agents) — badged so the injected task is
  // distinguishable from human typing
  const agentId = Number(meta.agent_id);
  if (Number.isFinite(agentId) && agentId > 0) {
    const wrapped = flattenOneLine(wrapRoomTaskPrompt(roomId, taskId, taskToken, prompt));
    if (tmuxInject(String(agentId), wrapped, typeof meta.tmux_session === "string" ? meta.tmux_session : undefined)) {
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
): boolean {
  if (initiatorSessionId === WEB_CONSOLE_ID) {
    // Human initiator — live event / OS notification handles this
    publishLiveEvent({
      type: "room.task",
      room_id: roomId,
      session_id: initiatorSessionId,
      payload: { event: "all_tasks_done", room_id: roomId },
    });
    return true;
  }
  const prompt = `${badge({ label: "任务完成通知" })} 你在聊天室（room_id=${roomId}）的全部任务已完成。用 room_read 读取结果并继续。`;

  // Managed initiator: deliver straight into its managed executor queue.
  const managedBinding = getManagedBindingBySession(db, initiatorSessionId);
  if (managedBinding) {
    try {
      const msg = askSession(db, {
        from_session: WEB_CONSOLE_ID,
        to_session: initiatorSessionId,
        question: prompt,
        room_id: roomId,
      });
      enqueueManagedTask(db, {
        messageId: msg.id,
        instanceId: managedBinding.instance_id,
        text: prompt,
      });
      getManagedExecutorForInstance(db, managedBinding.instance_id)?.kick(managedBinding.instance_id);
      logger.info({ roomId, initiatorSessionId }, "room: managed initiator notified");
      return true;
    } catch (err) {
      logger.warn(
        { roomId, initiatorSessionId, err: err instanceof Error ? err.message : String(err) },
        "room: failed to notify managed initiator",
      );
    }
  }

  // External agent initiator — inject a "come read results" prompt
  const session = getSession(db, initiatorSessionId);
  if (!session) return false;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(session.metadata ?? "{}"); } catch { /* ignore */ }
  const agentId = Number(meta.agent_id);
  if (!Number.isFinite(agentId) || agentId <= 0) return false;

  if (tmuxInject(String(agentId), prompt, typeof meta.tmux_session === "string" ? meta.tmux_session : undefined)) {
    logger.info({ roomId, initiatorSessionId }, "room: initiator summoned");
    return true;
  }
  return false;
}

let orchestrationHooksInstalled = false;

/**
 * Bridge ManagedExecutor terminal turn completions back into room_tasks and
 * workflow_steps:
 * - If a managed agent finishes a room_task turn without explicitly calling
 *   `room_write`, its final text automatically completes the task and wakes
 *   the initiator when all sibling tasks are done.
 * - If a managed run corresponds to a running workflow step, it settles that
 *   step and advances downstream DAG nodes automatically.
 */
export function installManagedOrchestrationHooks(): void {
  if (orchestrationHooksInstalled) return;
  orchestrationHooksInstalled = true;

  onManagedTurnFinalized((info) => {
    const { db, messageId, state, finalText, errorCode } = info;
    try {
      const linkedTask = db
        .prepare(
          `SELECT * FROM room_tasks WHERE message_id = ? AND status IN ('pending', 'running')`,
        )
        .get(messageId) as Record<string, unknown> | undefined;
      if (linkedTask) {
        const task = toTask(linkedTask);
        if (state === "completed") {
          writeResult(db, {
            task_id: task.id,
            task_token: task.task_token,
            result: finalText ?? "(受管任务完成)",
          });
        } else {
          db.prepare(
            `UPDATE room_tasks SET status = 'failed', result = ?, completed_at = ? WHERE id = ? AND status IN ('pending', 'running')`,
          ).run(errorCode ?? `任务状态：${state}`, nowIso(), task.id);
        }
        publishLiveEvent({
          type: "room.task",
          room_id: task.room_id,
          session_id: task.executor_session_id,
          payload: { task_id: task.id, status: state === "completed" ? "done" : "failed" },
        });
      }
    } catch (err) {
      logger.warn(
        { messageId, err: err instanceof Error ? err.message : String(err) },
        "room: auto-finalizing managed room_task failed",
      );
    }

    void onWorkflowStepMessageCompleted(db, messageId, {
      state,
      text: finalText,
      error: errorCode,
    }).catch((err) => {
      logger.warn(
        { messageId, err: err instanceof Error ? err.message : String(err) },
        "workflow: auto-advancing step on managed turn completion failed",
      );
    });
  });
}
