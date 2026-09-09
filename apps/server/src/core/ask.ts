import type { DB } from "./db.js";
import { askSession, type Message } from "./messages.js";
import { wakeSessionForMail } from "./wake/index.js";

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
}

export interface AskOutcome {
  message: Message;
  /** best-effort auto-answer wake; `{ woke: false }` variants explain why */
  wake: { woke: boolean; reason?: string };
}

export function askAndMaybeWake(db: DB, opts: AskOptions): AskOutcome {
  const message = askSession(db, opts);
  let wake: { woke: boolean; reason?: string } = { woke: false, reason: "skipped" };
  try {
    wake = wakeSessionForMail(db, opts.to_session);
  } catch {
    // best-effort — the mail is still delivered by the notice/forwarding paths
  }
  return { message, wake };
}
