import type { DB } from "./db.js";
import { logger } from "../log.js";
import {
  replyAsk,
  gatherUnseenMail,
  markMailDelivered,
  formatTypedMailPrompt,
  type Message,
} from "./messages.js";
import { getSession, sessionBusy } from "./sessions.js";
import { getAutoWake } from "./app-settings.js";
import { realTmuxIO, tmuxSessionName, type TmuxIO } from "./wake/tmux-inject.js";

export type { TmuxIO };

/**
 * Typed mail delivery (#162): push undelivered mail straight into the
 * target's terminal as a REAL prompt (badge-prefixed, single line) instead
 * of waiting for the next UserPromptSubmit hook. Prompt-level visibility is
 * only reachable by typing — this is the one channel Claude Code renders
 * like human input.
 *
 * Target resolution, cheapest and safest first:
 *   1. a tmux session Conflux stamped at launch (tmux wake / runtime agent)
 *   2. the runtime-agent convention conflux/agent-<id>
 *   3. the user's OWN terminal: claude_pid → tty → tmux pane. Claude-only
 *      (claude_pid is never recorded for codex) and idle-only: typing into
 *      a pane whose turn is running would interleave with a draft the human
 *      may be writing. The pane's foreground process must BE that claude —
 *      never type into whatever else took over the pane (editor, shell).
 *
 * Anything unresolvable keeps today's behavior: hook notice on the next
 * prompt. Delivery marks are written only after a successful send, so a
 * failed typed push never eats the mail.
 */

export interface PushResult {
  pushed: boolean;
  via?: "stamped-tmux" | "agent-tmux" | "pane";
  reason?: string;
}

export function pushMailTyped(db: DB, sessionId: string, io: TmuxIO = realTmuxIO): PushResult {
  const session = getSession(db, sessionId);
  if (!session) return { pushed: false, reason: "session not found" };
  if (!io.available()) return { pushed: false, reason: "tmux unavailable" };

  let meta: Record<string, unknown> = {};
  try {
    meta = session.metadata ? (JSON.parse(session.metadata) as Record<string, unknown>) : {};
  } catch {
    // unreadable metadata — treat as empty
  }

  // stamped = a USER session woken into tmux by us: same busy caution as the
  // pane path — mid-turn the TUI may sit on a permission dialog and typed
  // text would answer it. Runtime agents (below) keep always-inject: their
  // queue box is the lifeline rooms summon through.
  const stamped = typeof meta.tmux_session === "string" ? meta.tmux_session : null;
  const busy = sessionBusy(session.metadata);
  if (stamped && !busy && io.alive(stamped)) {
    return deliver(db, sessionId, stamped, "stamped-tmux", io);
  }

  const agentId = Number(meta.agent_id);
  if (Number.isFinite(agentId) && agentId > 0) {
    // tmuxSessionName IS the agent namer: conflux/agent-<id>
    const name = tmuxSessionName(agentId);
    if (io.alive(name)) return deliver(db, sessionId, name, "agent-tmux", io);
  }

  // the user's own terminal — see the claude-only / idle-only caveats above
  const pid = [meta.claude_pid, meta.runtime_pid].map(Number).find((n) => Number.isFinite(n) && n > 0) ?? null;
  const isClaude = (session.runtime ?? "claude") === "claude";
  if (pid !== null && isClaude && session.status === "active" && !busy) {
    const pane = io.paneForPid(pid);
    if (pane) return deliver(db, sessionId, pane, "pane", io);
  }
  return { pushed: false, reason: "no typed target" };
}

function deliver(
  db: DB,
  sessionId: string,
  target: string,
  via: NonNullable<PushResult["via"]>,
  io: TmuxIO,
): PushResult {
  const items = gatherUnseenMail(db, sessionId);
  const prompt = formatTypedMailPrompt(items);
  if (!prompt) return { pushed: false, reason: "inbox empty" };
  if (!io.send(target, prompt)) return { pushed: false, reason: "send failed" };
  markMailDelivered(db, sessionId, items);
  logger.info({ sessionId, via, items: items.length }, "typed mail delivered");
  return { pushed: true, via };
}

/**
 * replyAsk + best-effort typed push to the ASKER, so the answer lands in
 * their conversation immediately instead of surfacing on their next prompt.
 * All interfaces (MCP / HTTP / CLI) route replies through here.
 */
export function replyAskAndPush(
  db: DB,
  id: number,
  replierSessionId: string,
  reply: string,
  io: TmuxIO = realTmuxIO,
): Message {
  const msg = replyAsk(db, id, replierSessionId, reply);
  // auto_wake is the user's consent switch for Conflux steering sessions —
  // typing into terminals without it hijacks turns the setting exists to stop
  if (!getAutoWake(db)) return msg;
  try {
    pushMailTyped(db, msg.from_session, io);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "typed reply push failed — hook notice still owns delivery",
    );
  }
  return msg;
}
