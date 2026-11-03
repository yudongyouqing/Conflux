import type { DB } from "./db.js";
import { askSession, getMessage, type Message } from "./messages.js";
import { wakeSessionForMail, type WakeResult } from "./wake/index.js";
import { WEB_CONSOLE_ID } from "@conflux/shared";
import { randomUUID } from "node:crypto";
import { nowIso } from "./db.js";

/**
 * THE ask path: deliver a question and, when the addressee cannot see it
 * on its own (offline, or online-but-idle), launch the auto-answer wake.
 * Every interface — HTTP /messages/ask, /web/ask, /edges/:id/ask and the
 * MCP ask_session tool — goes through here so ask semantics never drift
 * between them.
 */

export interface AskOptions {
  from_session: string;
  to_session: string;
  question: string;
  /** chat-room shared thread marker (#151): replies stay visible in the room */
  room_id?: number | null;
}

export interface AskOutcome {
  message: Message;
  /** best-effort auto-answer wake; `{ woke: false }` variants explain why */
  wake: WakeResult;
}

export function askAndMaybeWake(db: DB, opts: AskOptions): AskOutcome {
  return completeAsk(db, prepareAsk(db, opts));
}

/** The caller is resolved by the interface, never from a retry request body. */
export function retryMessageDelivery(
  db: DB,
  id: number,
  actor: string,
  wake: typeof wakeSessionForMail = wakeSessionForMail,
): AskOutcome {
  return completeAsk(db, prepareRetryDelivery(db, id, actor), wake);
}

/**
 * Phase 1 of the ask path — DATABASE ONLY: the question insert and the
 * delivery claim in one transaction. Callers that retry the transaction on
 * lock contention (the HTTP server's ctx.write) must wrap ONLY this phase:
 * a rollback here is clean, so a retry can never duplicate anything.
 */
export interface AskPrepared {
  message: Message;
  /** Non-null when this call acquired the delivery claim and a wake should run. */
  claim: { id: number; token: string } | null;
}

export function prepareAsk(db: DB, opts: AskOptions): AskPrepared {
  const message = askSession(db, opts);
  return claimMessageWake(db, message.id, opts.from_session, true);
}

/** Phase 1 for manual retries — the same database-only contract as prepareAsk. */
export function prepareRetryDelivery(db: DB, id: number, actor: string): AskPrepared {
  return claimMessageWake(db, id, actor, false);
}

/**
 * Phase 2 of the ask path — runs the EXTERNAL wake (process spawn, typed
 * push) and records its outcome. Never call this inside a retried
 * transaction: the spawn/push cannot be rolled back while the rollback
 * WOULD erase the delivery claim that deduplicates it, so a retry would
 * launch the wake a second time. Execute strictly after phase 1 commits.
 */
export function completeAsk(
  db: DB,
  prepared: AskPrepared,
  wakeFn: typeof wakeSessionForMail = wakeSessionForMail,
): AskOutcome {
  const { message, claim } = prepared;
  if (!claim) return { message, wake: { woke: false, reason: "message already received" } };
  let wake: WakeResult;
  try {
    wake = wakeFn(db, message.to_session);
  } catch {
    wake = { woke: false, reason: "wake attempt failed", disposition: "failed" };
  }
  db.prepare(
    `UPDATE message_deliveries SET state = ?, reason = ?, claim_token = NULL,
    claim_expires_at = NULL WHERE message_id = ? AND claim_token = ?`,
  ).run(
    wake.woke ? "woken" : (wake.disposition ?? "queued"),
    wake.woke ? null : wake.reason.slice(0, 500),
    message.id,
    claim.token,
  );
  // A typed wake may already have marked the question seen.
  return { message: getMessage(db, message.id)!, wake };
}

function claimMessageWake(db: DB, id: number, actor: string, initial: boolean): AskPrepared {
  const token = randomUUID();
  let claimAcquired = false;
  const message = db
    .transaction(() => {
      const message = getMessage(db, id);
      if (!message) throw Object.assign(new Error("message not found"), { statusCode: 404 });
      if (
        actor !== WEB_CONSOLE_ID &&
        actor !== message.from_session &&
        actor !== message.to_session
      ) {
        throw Object.assign(new Error("not owner of this message"), { statusCode: 403 });
      }
      if (message.status !== "pending") {
        if (initial) return message;
        throw Object.assign(new Error("only pending messages can be retried"), { statusCode: 409 });
      }
      const now = nowIso();
      const expires = new Date(Date.now() + 60_000).toISOString();
      const claimed = db
        .prepare(
          `
    INSERT INTO message_deliveries (message_id, state, attempts, last_attempted_at, claim_token, claim_expires_at)
    VALUES (?, 'queued', 1, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET attempts = attempts + 1,
      last_attempted_at = excluded.last_attempted_at, claim_token = excluded.claim_token,
      claim_expires_at = excluded.claim_expires_at
    WHERE message_deliveries.claim_token IS NULL OR message_deliveries.claim_expires_at <= ?
  `,
        )
        .run(message.id, now, token, expires, now);
      if (!claimed.changes) {
        if (initial) return message;
        throw Object.assign(new Error("wake attempt already in progress"), { statusCode: 409 });
      }
      claimAcquired = true;
      return message;
    })
    .immediate();
  return { message, claim: claimAcquired ? { id: message.id, token } : null };
}
