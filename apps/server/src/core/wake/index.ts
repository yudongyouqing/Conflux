import { WEB_CONSOLE_ID } from "@conflux/shared";
import type { DB } from "../db.js";
import { logger } from "../../log.js";
import { getAutoWake, getSetting, getTerminalSettings, setSetting } from "../app-settings.js";
import { getSession, mergeSessionMeta } from "../sessions.js";
import { hasTranscript } from "../live.js";
import { pushMailTyped } from "../mail-push.js";
import { AUTO_WAKE_PROMPT, tmuxWakeCommand } from "./commands.js";
import { planClaudeWake } from "./claude.js";
import { planCodexWake } from "./codex.js";
import { launchWakeRun } from "./launcher.js";
import { realTmuxIO, type TmuxIO } from "./tmux-inject.js";
import { resolveConfig } from "../../config.js";

/**
 * Wake a session so it processes its inbox:
 *   - terminal reachable (Conflux tmux session, or the user's own tmux
 *     pane) → TYPE the mail in as a real prompt (#162) — prompt-level
 *     visibility, badge-prefixed, no process spawned at all
 *   - offline + tmux + claude → relaunch the REAL conversation inside a
 *     detached tmux session: a live, attachable TUI instead of a headless
 *     zombie; the mail is typed once the TUI has painted
 *   - active + busy  → skip: the running turn will surface the mail itself
 *   - everything else → headless wake (unchanged): offline claude resumes
 *     the real conversation; codex's open-TUI thread lock means a FRESH run
 *     seeded with the target's rollout digest answers instead
 *
 * Guards: auto_wake opt-in, CLI conversations only, dedup within
 * AUTO_WAKE_DEDUP_MS. dryRun previews the command without spawning.
 */

const AUTO_WAKE_DEDUP_MS = 90_000;
const TMUX_WAKE_POLL_MS = 400;
const TMUX_WAKE_MAX_POLLS = 40; // ~16s — a TUI that hasn't painted by then is broken

export type WakeResult =
  | { woke: true; command?: string }
  | { woke: false; reason: string };

export interface WakeOptions {
  dryRun?: boolean;
  now?: Date;
  claudeHome?: string;
  /** tmux/ps IO — injectable for tests */
  io?: TmuxIO;
  /** timer scheduler — injectable for tests (default setTimeout) */
  schedule?: (fn: () => void, ms: number) => void;
}

export function wakeSessionForMail(db: DB, sessionId: string, opts: WakeOptions = {}): WakeResult {
  if (!getAutoWake(db)) return { woke: false, reason: "auto_wake disabled" };
  if (sessionId === WEB_CONSOLE_ID || sessionId.startsWith("agent-")) {
    return { woke: false, reason: "not a CLI conversation" };
  }
  const session = getSession(db, sessionId);
  if (!session) return { woke: false, reason: "session not found" };

  // dedup: an in-flight wake (or a recent one) must not stack
  const now = (opts.now ?? new Date()).getTime();
  const last = getSetting(db, `auto-wake:${sessionId}`);
  if (last && now - Date.parse(last) < AUTO_WAKE_DEDUP_MS) {
    return { woke: false, reason: "wake already in flight" };
  }

  const io = opts.io ?? realTmuxIO;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));

  // #162 typed delivery first: if the target's terminal is reachable, the
  // undelivered mail goes in as a badged prompt — no wake needed at all.
  // (Busy user sessions resolve no pane target inside pushMailTyped and
  // fall through to the busy skip below.)
  if (!opts.dryRun && io.available()) {
    const pushed = pushMailTyped(db, sessionId, io);
    if (pushed.pushed) {
      setSetting(db, `auto-wake:${sessionId}`, new Date(now).toISOString());
      return { woke: true };
    }
    // no typed target / send failed — fall through to the wake ladder
  }

  let runtime: "claude" | "codex" = "claude";
  let meta: Record<string, unknown> | null = null;
  try {
    meta = session.metadata ? (JSON.parse(session.metadata) as Record<string, unknown>) : null;
    if (meta?.runtime === "codex") runtime = "codex";
  } catch {
    // default runtime
  }

  if (session.status === "active" && meta?.busy === true) {
    return { woke: false, reason: "busy — the running turn will surface the mail" };
  }

  const exe = wakeExe(db, runtime);
  const offline = session.status !== "active";

  // #162 offline + claude + tmux: relaunch the real conversation as a live
  // TUI inside tmux (conflux/<sessionId>, detached — `tmux attach` to watch).
  // The name is stamped into metadata so later injections address it
  // directly. If the TUI never paints, the mail stays pending and the
  // hook-notice path still owns delivery.
  if (
    offline &&
    runtime === "claude" &&
    io.available() &&
    hasTranscript(sessionId, session.project_dir, opts.claudeHome)
  ) {
    // user-session namespace: conflux/<sessionId> (tmuxSessionName is the
    // runtime-AGENT namer — conflux/agent-<registry id> — never reuse it here)
    const name = `conflux/${sessionId}`;
    const command = tmuxWakeCommand(sessionId, exe);
    if (opts.dryRun) return { woke: true, command };
    if (io.launch({ name, command, cwd: session.project_dir })) {
      mergeSessionMeta(db, sessionId, { tmux_session: name });
      scheduleTmuxWakePush(db, sessionId, name, io, schedule);
      setSetting(db, `auto-wake:${sessionId}`, new Date(now).toISOString());
      return { woke: true, command };
    }
    // launch failed — fall through to headless
  }

  const plan =
    runtime === "codex"
      ? planCodexWake({
          sessionId,
          exe,
          offline,
          codexSessionId:
            typeof meta?.codex_session_id === "string" ? (meta.codex_session_id as string) : null,
        })
      : planClaudeWake({
          sessionId,
          exe,
          offline,
          projectDir: session.project_dir,
          claudeHome: opts.claudeHome,
        });
  if ("refuse" in plan) return { woke: false, reason: plan.refuse };

  const launch = launchWakeRun({
    db,
    sessionId,
    dataDir: resolveConfig("global").dataDir,
    projectDir: session.project_dir,
    command: plan.command,
    prompt: plan.prompt ?? AUTO_WAKE_PROMPT,
    pinCodex: runtime === "codex",
    dryRun: opts.dryRun,
  });
  if (!launch.ok) return { woke: false, reason: launch.error };
  if (!opts.dryRun) {
    setSetting(db, `auto-wake:${sessionId}`, new Date(now).toISOString());
  } else {
    logger.debug({ sessionId }, "auto-wake dry-run");
  }
  return { woke: true, command: launch.command };
}

/**
 * Poll the freshly launched TUI until it has painted twice in a row, then
 * push the undelivered mail as a typed prompt. Typing before the TUI is up
 * loses keystrokes; giving up leaves the mail pending for the hook path.
 */
function scheduleTmuxWakePush(
  db: DB,
  sessionId: string,
  target: string,
  io: TmuxIO,
  schedule: (fn: () => void, ms: number) => void,
): void {
  let polls = 0;
  let stable = 0;
  const poll = (): void => {
    if (++polls > TMUX_WAKE_MAX_POLLS) return;
    const painted = io.capture(target).trim().length > 0;
    stable = painted ? stable + 1 : 0;
    if (stable >= 2) {
      try {
        pushMailTyped(db, sessionId, io);
      } catch (err) {
        logger.warn(
          { sessionId, err: err instanceof Error ? err.message : String(err) },
          "tmux wake push failed — mail stays pending for the hook path",
        );
      }
      return;
    }
    schedule(poll, TMUX_WAKE_POLL_MS);
  };
  schedule(poll, TMUX_WAKE_POLL_MS);
}

function wakeExe(db: DB, runtime: "claude" | "codex"): string {
  const settings = getTerminalSettings(db);
  return runtime === "codex"
    ? process.env.CODEX_PATH || settings.codex_path
    : process.env.CLAUDE_PATH || settings.claude_path;
}
