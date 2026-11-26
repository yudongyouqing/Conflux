import { randomUUID } from "node:crypto";
import {
  WEB_CONSOLE_ID,
  WEB_CONSOLE_NAME,
  type ManagedDeliveryMode,
  type Message,
} from "@conflux/shared";
import { nowIso, type DB } from "./db.js";
import { getRuntimeSettings } from "./runtime-env.js";
import { getThread, heartbeatThread } from "./threads/store.js";
import { getThreadManager } from "./threads/executor.js";
import { publishLiveEvent } from "./event-bus.js";

interface MessageRow {
  id: number;
  edge_id: number | null;
  from_thread: string;
  to_thread: string;
  question: string;
  context: string | null;
  reply: string | null;
  status: string;
  room_id: number | null;
  trace_id: string | null;
  hop_count: number;
  created_at: string;
  replied_at: string | null;
  from_name?: string | null;
  to_name?: string | null;
  from_host?: string | null;
  to_host?: string | null;
}

const messageWaiters = new Map<number, Set<(msg: Message) => void>>();

function notifyMessageWaiters(msg: Message): void {
  const listeners = messageWaiters.get(msg.id);
  if (!listeners || listeners.size === 0) return;
  messageWaiters.delete(msg.id);
  for (const resolve of listeners) {
    try {
      resolve(msg);
    } catch {
      // ignore waiter errors
    }
  }
}

export function waitForMessageOutcome(
  db: DB,
  messageId: number,
  waitSeconds: number,
): Promise<{ message: Message; timed_out: boolean }> {
  const existing = getMessage(db, messageId);
  if (existing && (existing.status === "replied" || existing.status === "cancelled")) {
    return Promise.resolve({ message: existing, timed_out: false });
  }
  const boundedMs = Math.max(1, Math.min(waitSeconds, 60)) * 1000;
  return new Promise((resolve) => {
    let settled = false;
    const onResolved = (msg: Message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ message: msg, timed_out: false });
    };
    let set = messageWaiters.get(messageId);
    if (!set) {
      set = new Set();
      messageWaiters.set(messageId, set);
    }
    set.add(onResolved);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      messageWaiters.get(messageId)?.delete(onResolved);
      if (messageWaiters.get(messageId)?.size === 0) {
        messageWaiters.delete(messageId);
      }
      const latest = getMessage(db, messageId) ?? existing!;
      resolve({ message: latest, timed_out: true });
    }, boundedMs);
    timer.unref?.();
  });
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    edge_id: row.edge_id,
    from_session: row.from_thread,
    to_session: row.to_thread,
    ...(row.from_name ? { from_name: row.from_name } : {}),
    ...(row.to_name ? { to_name: row.to_name } : {}),
    ...(row.from_host ? { from_host: row.from_host } : {}),
    ...(row.to_host ? { to_host: row.to_host } : {}),
    question: row.question,
    context: row.context ?? null,
    reply: row.reply,
    status: row.status as Message["status"],
    room_id: row.room_id,
    trace_id: row.trace_id ?? null,
    hop_count: row.hop_count ?? 0,
    created_at: row.created_at,
    replied_at: row.replied_at,
  };
}

function displayNameFor(db: DB, id: string): string {
  if (id === WEB_CONSOLE_ID) return WEB_CONSOLE_NAME;
  return getThread(db, id)?.name ?? id.slice(0, 8);
}

/**
 * Autonomous cross-agent loop guardrail:
 *  - Human (`web-console`) initiates at hop 0 and is exempt from cooldown.
 *  - Agent-to-agent calls inherit upstream trace_id + hop depth + 1, capped at `max_autonomous_hops` (default 5).
 *  - Repeated calls between the exact same pair within `pair_cooldown_ms` are blocked with 429.
 */
export function enforceAutonomousGuardrails(
  db: DB,
  fromThread: string,
  toThread: string,
  explicitHopCount?: number,
): number {
  return resolveCallTraceAndHop(db, fromThread, toThread, explicitHopCount).hopCount;
}

function resolveCallTraceAndHop(
  db: DB,
  fromThread: string,
  toThread: string,
  explicitHopCount?: number,
  explicitTraceId?: string | null,
): { hopCount: number; traceId: string } {
  if (fromThread === WEB_CONSOLE_ID) {
    return { hopCount: 0, traceId: explicitTraceId?.trim() || `tr_${randomUUID().slice(0, 8)}` };
  }
  const settings = getRuntimeSettings(db);
  const recentCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const upstream = db
    .prepare(
      `SELECT hop_count, trace_id FROM messages
       WHERE to_thread = ? AND created_at >= ? AND status != 'cancelled'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(fromThread, recentCutoff) as { hop_count: number; trace_id: string | null } | undefined;

  const nextHop =
    typeof explicitHopCount === "number" && Number.isFinite(explicitHopCount)
      ? explicitHopCount
      : (upstream?.hop_count ?? 0) + 1;
  const traceId =
    explicitTraceId?.trim() || upstream?.trace_id?.trim() || `tr_${randomUUID().slice(0, 8)}`;

  if (nextHop > settings.max_autonomous_hops) {
    throw Object.assign(
      new Error(
        `自主协作跳数已达上限（${nextHop} > ${settings.max_autonomous_hops}），已自动暂停以防死循环，请由人工介入确认`,
      ),
      { statusCode: 429 },
    );
  }

  if (settings.pair_cooldown_ms > 0) {
    const lastPair = db
      .prepare(
        `SELECT created_at FROM messages
         WHERE ((from_thread = ? AND to_thread = ?) OR (from_thread = ? AND to_thread = ?))
           AND status != 'cancelled'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(fromThread, toThread, toThread, fromThread) as { created_at: string } | undefined;
    if (lastPair) {
      const elapsed = Date.now() - Date.parse(lastPair.created_at);
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < settings.pair_cooldown_ms) {
        throw Object.assign(
          new Error(
            `同对 Agent 自主互调触发冷却护栏（距上次仅 ${elapsed}ms < ${settings.pair_cooldown_ms}ms），请稍后再试`,
          ),
          { statusCode: 429 },
        );
      }
    }
  }
  return { hopCount: nextHop, traceId };
}

const SELECT_MESSAGE_SQL = `
  SELECT m.*,
    COALESCE(tf.name, CASE WHEN m.from_thread = ? THEN ? ELSE NULL END) AS from_name,
    COALESCE(tt.name, CASE WHEN m.to_thread = ? THEN ? ELSE NULL END) AS to_name,
    tf.host AS from_host,
    tt.host AS to_host
  FROM messages m
  LEFT JOIN agent_threads tf ON tf.id = m.from_thread
  LEFT JOIN agent_threads tt ON tt.id = m.to_thread
`;

export function getMessage(db: DB, id: number): Message | null {
  const row = db
    .prepare(`${SELECT_MESSAGE_SQL} WHERE m.id = ?`)
    .get(WEB_CONSOLE_ID, WEB_CONSOLE_NAME, WEB_CONSOLE_ID, WEB_CONSOLE_NAME, id) as
    | MessageRow
    | undefined;
  return row ? toMessage(row) : null;
}

export function listMessages(
  db: DB,
  opts: {
    from?: string;
    to?: string;
    room_id?: number;
    status?: string;
    statuses?: string[];
    limit?: number;
  } = {},
): Message[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.from) {
    clauses.push("m.from_thread = ?");
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push("m.to_thread = ?");
    params.push(opts.to);
  }
  if (opts.room_id !== undefined) {
    clauses.push("m.room_id = ?");
    params.push(opts.room_id);
  }
  if (opts.status) {
    clauses.push("m.status = ?");
    params.push(opts.status);
  }
  if (opts.statuses && opts.statuses.length > 0) {
    clauses.push(`m.status IN (${opts.statuses.map(() => "?").join(",")})`);
    params.push(...opts.statuses);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const order = opts.room_id !== undefined ? "ORDER BY m.id ASC" : "ORDER BY m.id DESC";
  const rows = db
    .prepare(`${SELECT_MESSAGE_SQL} ${where} ${order} LIMIT ?`)
    .all(WEB_CONSOLE_ID, WEB_CONSOLE_NAME, WEB_CONSOLE_ID, WEB_CONSOLE_NAME, ...params, limit) as MessageRow[];
  return rows.map(toMessage);
}

export function checkInbox(db: DB, threadId: string): Message[] {
  heartbeatThread(db, threadId);
  const rows = db
    .prepare(
      `${SELECT_MESSAGE_SQL}
       WHERE m.to_thread = ? AND m.status IN ('pending', 'seen')
       ORDER BY m.id ASC`,
    )
    .all(WEB_CONSOLE_ID, WEB_CONSOLE_NAME, WEB_CONSOLE_ID, WEB_CONSOLE_NAME, threadId) as MessageRow[];
  if (rows.length > 0) {
    db.prepare(`UPDATE messages SET status = 'seen' WHERE to_thread = ? AND status = 'pending'`).run(
      threadId,
    );
  }
  return rows.map(toMessage);
}

async function dispatchToManagedIfApplicable(
  db: DB,
  msg: Message,
  deliveryMode: ManagedDeliveryMode = "queue",
): Promise<{ delivered: boolean; delivery_method: string }> {
  const target = getThread(db, msg.to_session);
  if (!target) {
    return { delivered: false, delivery_method: "missing-target" };
  }
  const manager = getThreadManager();
  if (target.kind === "managed" && manager) {
    const senderLabel = displayNameFor(db, msg.from_session);
    const fullPrompt = msg.context?.trim()
      ? `${msg.question}\n\n---\n[附带上下文 / Diff]\n${msg.context.trim()}`
      : msg.question;
    const { steered } = await manager.enqueuePrompt(target.id, {
      prompt: fullPrompt,
      messageId: msg.id,
      roomId: msg.room_id ?? null,
      deliveryMode,
      senderLabel,
    });
    return {
      delivered: true,
      delivery_method: steered
        ? `managed-${target.runtime}:steered`
        : `managed-${target.runtime}:${target.id}`,
    };
  }
  return {
    delivered: false,
    delivery_method: target.kind === "external" ? "external-mcp-inbox" : "queued",
  };
}

/**
 * Send a cross-thread question, enforce autonomous loop guardrails + target
 * incoming-call policy (auto / ask / dnd — never blocking outbound calls),
 * update the live communication graph edge, broadcast SSE, and dispatch.
 */
export async function askThread(
  db: DB,
  input: {
    from_thread: string;
    to_thread: string;
    question: string;
    context?: string | null;
    room_id?: number | null;
    delivery_mode?: ManagedDeliveryMode;
    hop_count?: number;
    trace_id?: string | null;
  },
): Promise<{
  message: Message;
  delivered: boolean;
  delivery_method: string;
}> {
  if (input.from_thread === input.to_thread) {
    throw Object.assign(new Error("cannot ask yourself"), { statusCode: 400 });
  }
  const question = input.question?.trim();
  if (!question) {
    throw Object.assign(new Error("question is required"), { statusCode: 400 });
  }
  const target = getThread(db, input.to_thread);
  if (!target) {
    throw Object.assign(new Error(`target thread not found: ${input.to_thread}`), { statusCode: 404 });
  }

  // Incoming-call policy governs incoming peer calls only; outbound calls are never blocked.
  if (input.from_thread !== WEB_CONSOLE_ID && target.incoming_call_mode === "dnd") {
    throw Object.assign(
      new Error(`节点「${target.name}」当前处于免打扰（DND）状态，已拒绝来电`),
      { statusCode: 403 },
    );
  }

  const { hopCount, traceId } = resolveCallTraceAndHop(
    db,
    input.from_thread,
    input.to_thread,
    input.hop_count,
    input.trace_id,
  );
  const needsHumanApproval =
    input.from_thread !== WEB_CONSOLE_ID && target.incoming_call_mode === "ask";
  const initialStatus = needsHumanApproval ? "awaiting_approval" : "pending";
  const contextText = input.context?.trim() || null;

  const msg = db
    .transaction(() => {
      const now = nowIso();
      db.prepare(
        `INSERT INTO edges (from_thread, to_thread, weight, last_interact_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(from_thread, to_thread)
         DO UPDATE SET weight = weight + 1, last_interact_at = excluded.last_interact_at`,
      ).run(input.from_thread, input.to_thread, now);
      const edgeRow = db
        .prepare(`SELECT rowid AS id FROM edges WHERE from_thread = ? AND to_thread = ?`)
        .get(input.from_thread, input.to_thread) as { id: number };
      const res = db
        .prepare(
          `INSERT INTO messages
           (edge_id, from_thread, to_thread, question, context, status, room_id, trace_id, hop_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          edgeRow.id,
          input.from_thread,
          input.to_thread,
          question,
          contextText,
          initialStatus,
          input.room_id ?? null,
          traceId,
          hopCount,
          now,
        );
      return getMessage(db, Number(res.lastInsertRowid))!;
    })
    .immediate();

  publishLiveEvent({
    type: "peer.message",
    project_id: target.project_id,
    thread_id: target.id,
    room_id: input.room_id ?? null,
    payload: { phase: needsHumanApproval ? "awaiting_approval" : "asked", message: msg },
  });

  if (input.room_id) {
    publishLiveEvent({
      type: "room.message",
      project_id: target.project_id,
      thread_id: target.id,
      room_id: input.room_id,
      payload: { phase: "asked", message: msg },
    });
  }

  if (needsHumanApproval) {
    return {
      message: msg,
      delivered: false,
      delivery_method: "awaiting-human-approval",
    };
  }

  const dispatched = await dispatchToManagedIfApplicable(db, msg, input.delivery_mode ?? "queue");
  return {
    message: msg,
    ...dispatched,
  };
}

export async function approvePendingCall(
  db: DB,
  messageId: number,
): Promise<{ message: Message; delivered: boolean; delivery_method: string }> {
  const existing = getMessage(db, messageId);
  if (!existing) throw Object.assign(new Error("message not found"), { statusCode: 404 });
  if (existing.status !== "awaiting_approval") {
    throw Object.assign(new Error(`call is not awaiting approval (status=${existing.status})`), {
      statusCode: 409,
    });
  }
  db.prepare(`UPDATE messages SET status = 'pending' WHERE id = ? AND status = 'awaiting_approval'`).run(
    messageId,
  );
  const updated = getMessage(db, messageId)!;
  const target = getThread(db, updated.to_session);
  publishLiveEvent({
    type: "peer.message",
    project_id: target?.project_id ?? null,
    thread_id: updated.to_session,
    payload: { phase: "approved", message: updated },
  });
  const dispatched = await dispatchToManagedIfApplicable(db, updated, "queue");
  return { message: updated, ...dispatched };
}

export function hangupCall(db: DB, messageId: number, reason = "已由用户手动挂断"): Message {
  const existing = getMessage(db, messageId);
  if (!existing) throw Object.assign(new Error("message not found"), { statusCode: 404 });
  if (existing.status === "replied" || existing.status === "cancelled") {
    return existing;
  }
  db.prepare(
    `UPDATE messages SET status = 'cancelled', reply = COALESCE(reply, ?), replied_at = ? WHERE id = ?`,
  ).run(reason, nowIso(), messageId);
  const updated = getMessage(db, messageId)!;
  notifyMessageWaiters(updated);
  const target = getThread(db, updated.to_session);
  publishLiveEvent({
    type: "peer.message",
    project_id: target?.project_id ?? null,
    thread_id: updated.to_session,
    payload: { phase: "cancelled", message: updated },
  });
  return updated;
}

export function replyMessage(
  db: DB,
  messageId: number,
  replierThreadId: string,
  replyText: string,
): Message {
  const existing = getMessage(db, messageId);
  if (!existing) throw Object.assign(new Error("message not found"), { statusCode: 404 });
  if (existing.to_session !== replierThreadId && replierThreadId !== WEB_CONSOLE_ID) {
    throw Object.assign(new Error("not the addressee of this message"), { statusCode: 403 });
  }
  db.prepare(
    `UPDATE messages SET reply = ?, status = 'replied', replied_at = ? WHERE id = ?`,
  ).run(replyText, nowIso(), messageId);
  heartbeatThread(db, replierThreadId);
  const updated = getMessage(db, messageId)!;
  notifyMessageWaiters(updated);
  const target = getThread(db, replierThreadId);
  publishLiveEvent({
    type: "peer.message",
    project_id: target?.project_id ?? null,
    thread_id: replierThreadId,
    room_id: updated.room_id,
    payload: { phase: "replied", message: updated },
  });
  if (updated.room_id) {
    publishLiveEvent({
      type: "room.message",
      thread_id: replierThreadId,
      room_id: updated.room_id,
      payload: { phase: "replied", message: updated },
    });
  }
  return updated;
}
