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
  const message = askSession(db, opts);
  return attemptMessageWake(db, message.id, opts.from_session, wakeSessionForMail, true);
}

/** The caller is resolved by the interface, never from a retry request body. */
export function retryMessageDelivery(
  db: DB,
  id: number,
  actor: string,
  wake: typeof wakeSessionForMail = wakeSessionForMail,
): AskOutcome {
  return attemptMessageWake(db, id, actor, wake);
}

function attemptMessageWake(
  db: DB,
  id: number,
  actor: string,
  wakeFn = wakeSessionForMail,
  initial = false,
): AskOutcome {
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
  if (!claimAcquired) return { message, wake: { woke: false, reason: "message already received" } };
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
    token,
  );
  // A typed wake may already have marked the question seen.
  return { message: getMessage(db, message.id)!, wake };
}
