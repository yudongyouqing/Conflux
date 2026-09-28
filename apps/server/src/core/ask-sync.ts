import type { DB } from "./db.js";
import { askAndMaybeWake } from "./ask.js";

/**
 * Synchronous ask (#102): deliver + wake, then WAIT in-turn for the reply.
 * The asking AI gets the answer as the tool result of the same turn — real
 * conversation instead of "leave a note and check next turn". On timeout the
 * message stays delivered/pending; the asker falls back to the async layers
 * (hook push / OS notification / check_replies).
 */

export interface SyncAskInput {
  from_session: string;
  to_session: string;
  question: string;
  /** how long to wait for the reply before giving up (default 5 min) */
  timeoutMs?: number;
  /** poll interval (default 2 s; tests shrink it) */
  pollMs?: number;
  /** wake trigger — defaults to the real askAndMaybeWake */
  wake?: (input: { from_session: string; to_session: string; question: string }) => ReturnType<typeof askAndMaybeWake>;
  /** sleep primitive — injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

export type SyncAskResult =
  | {
      status: "replied";
      message_id: number;
      reply: string;
      waitedMs: number;
      wake: { woke: boolean; reason?: string };
    }
  | {
      status: "timeout";
      message_id: number;
      reply: null;
      waitedMs: number;
      wake: { woke: boolean; reason?: string };
    };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function askAndReplySync(db: DB, input: SyncAskInput): Promise<SyncAskResult> {
  const timeoutMs = input.timeoutMs ?? 300_000;
  const pollMs = input.pollMs ?? 2_000;
  const sleep = input.sleep ?? defaultSleep;
  const doWake =
    input.wake ??
    ((i: { from_session: string; to_session: string; question: string }) =>
      askAndMaybeWake(db, i));

  const started = Date.now();
  const r = doWake({
    from_session: input.from_session,
    to_session: input.to_session,
    question: input.question,
  });
  const messageId = r.message.id;
  const wake = r.wake;

  const stmt = db.prepare(`SELECT reply FROM messages WHERE id = ?`);
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const row = stmt.get(messageId) as { reply: string | null } | undefined;
    if (row?.reply) {
      return {
        status: "replied",
        message_id: messageId,
        reply: row.reply,
        waitedMs: Date.now() - started,
        wake,
      };
    }
  }
  return {
    status: "timeout",
    message_id: messageId,
    reply: null,
    waitedMs: Date.now() - started,
    wake,
  };
}
