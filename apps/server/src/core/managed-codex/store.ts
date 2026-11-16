import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { nowIso } from "../db.js";
import { replyAsk } from "../messages.js";
import type { ManagedRunState, ManagedTaskInput } from "./types.js";

/**
 * Database operations for the managed Codex executor. Everything here is
 * DATABASE-ONLY: callers must run process spawns, stdin writes and RPC calls
 * only AFTER the transaction that staged the state change has committed, so
 * a rolled-back retry can never duplicate an external effect. Ownership of a
 * managed instance is pinned by the binding's owner token; run mutations
 * from any other token are refused rather than trusted.
 */

export interface ManagedRunRow {
  id: number;
  message_id: number;
  instance_id: string;
  thread_id: string | null;
  turn_id: string | null;
  state: ManagedRunState;
  request_id: string | null;
  /** Snapshot of the exact prompt text this task will send. */
  submit_text: string;
  final_text: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  instance_id: string;
  session_id: string;
  thread_id: string;
  active_turn_id: string | null;
  owner_token: string;
  updated_at: string;
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function selectRun(db: DB, id: number): ManagedRunRow | null {
  const row = db
    .prepare(`SELECT * FROM managed_codex_runs WHERE id = ?`)
    .get(id) as ManagedRunRow | undefined;
  return row ?? null;
}

/**
 * Create or refresh the binding of a managed instance to its root thread.
 * The caller supplies a fresh owner token; an existing binding is replaced
 * (thread takeover by a new manager generation), which implicitly expires
 * the previous owner's rights.
 */
export function upsertManagedBinding(
  db: DB,
  input: {
    instanceId: string;
    sessionId: string;
    threadId: string;
    ownerToken: string;
    activeTurnId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO managed_codex_bindings (instance_id, session_id, thread_id, active_turn_id, owner_token, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       session_id = excluded.session_id,
       thread_id = excluded.thread_id,
       active_turn_id = excluded.active_turn_id,
       owner_token = excluded.owner_token,
       updated_at = excluded.updated_at`,
  ).run(
    input.instanceId,
    input.sessionId,
    input.threadId,
    input.activeTurnId ?? null,
    input.ownerToken,
    nowIso(),
  );
}

/**
 * Rotate the binding's owner token (recovery/takeover path) and hand the
 * instance to the new manager generation. Returns the new token; the old
 * owner's subsequent run mutations will be refused.
 */
export function replaceManagedBindingOwner(
  db: DB,
  instanceId: string,
  identity: { sessionId: string; threadId: string },
): string {
  const ownerToken = randomUUID();
  upsertManagedBinding(db, { instanceId, ownerToken, ...identity });
  return ownerToken;
}

export function getManagedBinding(db: DB, instanceId: string): BindingRow | null {
  const row = db
    .prepare(`SELECT * FROM managed_codex_bindings WHERE instance_id = ?`)
    .get(instanceId) as BindingRow | undefined;
  return row ?? null;
}

/**
 * Resolve a managed binding by its SESSION — the persistence-level routing
 * key. The ask path uses this in whatever process it runs (HTTP server,
 * MCP child, CLI one-shot): enqueueing is database-only, and the server
 * holding the live executor drains the queue.
 */
export function getManagedBindingBySession(db: DB, sessionId: string): BindingRow | null {
  const row = db
    .prepare(`SELECT * FROM managed_codex_bindings WHERE session_id = ? ORDER BY updated_at DESC`)
    .get(sessionId) as BindingRow | undefined;
  return row ?? null;
}

/** Does `ownerToken` currently own this instance's binding? */
function ownsBinding(db: DB, instanceId: string, ownerToken: string): boolean {
  const row = db
    .prepare(`SELECT owner_token FROM managed_codex_bindings WHERE instance_id = ?`)
    .get(instanceId) as { owner_token: string } | undefined;
  return row?.owner_token === ownerToken;
}

/**
 * Enqueue one task per message — the idempotency anchor of the whole
 * executor. A message already bound to a DIFFERENT instance conflicts; a
 * repeat enqueue for the same instance returns the existing run unchanged,
 * so HTTP retries and crash-restart replays never double-submit.
 */
export function enqueueManagedTask(db: DB, input: ManagedTaskInput): ManagedRunRow {
  return db
    .transaction((): ManagedRunRow => {
      const message = db
        .prepare(`SELECT id FROM messages WHERE id = ?`)
        .get(input.messageId) as { id: number } | undefined;
      if (!message) throw notFound(`message not found: ${input.messageId}`);
      const now = nowIso();
      db.prepare(
        `INSERT INTO managed_codex_runs (message_id, instance_id, state, submit_text, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      ).run(input.messageId, input.instanceId, input.text, now, now);
      const row = db
        .prepare(`SELECT * FROM managed_codex_runs WHERE message_id = ?`)
        .get(input.messageId) as ManagedRunRow;
      if (row.instance_id !== input.instanceId) {
        throw conflict(
          `message ${input.messageId} is already bound to instance ${row.instance_id}`,
        );
      }
      return row;
    })
    .immediate();
}

/**
 * Atomically claim the oldest queued run of an instance as `submitting`,
 * assigning the request id that turn/start will carry as its
 * clientUserMessageId. Only the binding's current owner may claim; two
 * racing claimants (or two generations of the manager) cannot both win —
 * the loser gets null and must not send anything.
 */
export function claimNextQueuedRun(
  db: DB,
  input: { instanceId: string; ownerToken: string },
): ManagedRunRow | null {
  return db
    .transaction((): ManagedRunRow | null => {
      if (!ownsBinding(db, input.instanceId, input.ownerToken)) return null;
      const requestId = randomUUID();
      // Pick the candidate by primary key first, then update by that id.
      // (After an UPDATE, last_insert_rowid() does NOT identify the updated
      // row — it can echo an unrelated rowid from the same statement.)
      const candidate = db
        .prepare(
          `SELECT id FROM managed_codex_runs
           WHERE instance_id = ? AND state = 'queued'
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(input.instanceId) as { id: number } | undefined;
      if (!candidate) return null;
      const res = db
        .prepare(
          `UPDATE managed_codex_runs
           SET state = 'submitting', request_id = ?, updated_at = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(requestId, nowIso(), candidate.id);
      if (!res.changes) return null;
      return selectRun(db, candidate.id);
    })
    .immediate();
}

export interface ManagedRunPatch {
  state?: ManagedRunState;
  threadId?: string;
  turnId?: string;
  finalText?: string;
  errorCode?: string;
}

/**
 * Conditionally move a run between states: the update lands only if the run
 * is currently in one of `fromStates` AND `ownerToken` still owns the
 * instance. Returns the updated row, or null when the precondition failed
 * (stale generation, wrong phase, or already terminal) — callers treat null
 * as "someone else owns the truth now", never as a retry-and-resend signal.
 */
export function updateManagedRun(
  db: DB,
  runId: number,
  ownerToken: string,
  patch: ManagedRunPatch,
  guard: { fromStates: ManagedRunState[] },
): ManagedRunRow | null {
  return db
    .transaction((): ManagedRunRow | null => {
      const current = selectRun(db, runId);
      if (!current) throw notFound(`managed run not found: ${runId}`);
      if (!ownsBinding(db, current.instance_id, ownerToken)) return null;
      // Terminal states are frozen: late notifications from a finished turn
      // must not flip a completed run into failed/interrupted.
      if (["completed", "failed", "interrupted"].includes(current.state)) return null;
      if (!guard.fromStates.includes(current.state)) return null;
      const next: ManagedRunPatch = { ...patch };
      db.prepare(
        `UPDATE managed_codex_runs SET
           state = COALESCE(?, state),
           thread_id = COALESCE(?, thread_id),
           turn_id = COALESCE(?, turn_id),
           final_text = COALESCE(?, final_text),
           error_code = COALESCE(?, error_code),
           updated_at = ?
         WHERE id = ?`,
      ).run(
        next.state ?? null,
        next.threadId ?? null,
        next.turnId ?? null,
        next.finalText ?? null,
        next.errorCode ?? null,
        nowIso(),
        runId,
      );
      return selectRun(db, runId);
    })
    .immediate();
}

/**
 * Flip a run into a terminal state AND write the reply to the originating
 * message as ONE transaction. Splitting the two writes left a permanent
 * loss window: a reply failure after the terminal commit could never be
 * retried (terminal runs are frozen and excluded from recovery), leaving
 * run=completed with the asker's message forever pending. Here a reply
 * failure rolls the terminal flip back too, so the next notification — or
 * recovery — retries the whole handoff.
 */
export function finalizeRunAndReply(
  db: DB,
  input: {
    runId: number;
    ownerToken: string;
    patch: ManagedRunPatch;
    fromStates: ManagedRunState[];
    replierSessionId: string;
    replyText: string;
  },
): ManagedRunRow | null {
  return db
    .transaction((): ManagedRunRow | null => {
      const moved = updateManagedRun(db, input.runId, input.ownerToken, input.patch, {
        fromStates: input.fromStates,
      });
      if (!moved) return null;
      replyAsk(db, moved.message_id, input.replierSessionId, input.replyText);
      return moved;
    })
    .immediate();
}

/**
 * Mark a run `unknown` — the crash-window state (a turn/start may have been
 * sent but no confirmation ever arrived). Unlike normal transitions this is
 * allowed from any non-terminal state and from ANY writer, because the one
 * thing that must never happen is silently re-running the task.
 */
export function markRunUnknown(db: DB, runId: number, reason: string): ManagedRunRow | null {
  const current = selectRun(db, runId);
  if (!current) return null;
  if (["completed", "failed", "interrupted"].includes(current.state)) return current;
  db.prepare(
    `UPDATE managed_codex_runs SET state = 'unknown', error_code = ?, updated_at = ? WHERE id = ?`,
  ).run(reason.slice(0, 500), nowIso(), runId);
  return selectRun(db, runId);
}

export interface ManagedEventInsert {
  instanceId: string;
  runId?: number | null;
  type: "text" | "tool" | "approval" | "status" | "error";
  payload: Record<string, unknown>;
}

/** Persist one normalized event; returns its replay sequence number. */
export function appendManagedEvent(db: DB, input: ManagedEventInsert): number {
  const res = db
    .prepare(
      `INSERT INTO managed_codex_events (instance_id, run_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.instanceId, input.runId ?? null, input.type, JSON.stringify(input.payload), nowIso());
  return Number(res.lastInsertRowid);
}

/** Replay events for an instance strictly after `after`, newest last. */
export function listManagedEvents(
  db: DB,
  input: { instanceId: string; after?: number; limit?: number },
): Array<{
  sequence: number;
  instance_id: string;
  run_id: number | null;
  type: string;
  payload: string;
  created_at: string;
}> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  return db
    .prepare(
      `SELECT * FROM managed_codex_events
       WHERE instance_id = ? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`,
    )
    .all(input.instanceId, input.after ?? 0, limit) as Array<{
    sequence: number;
    instance_id: string;
    run_id: number | null;
    type: string;
    payload: string;
    created_at: string;
  }>;
}
