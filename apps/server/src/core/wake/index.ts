import { WEB_CONSOLE_ID } from "@conflux/shared";
import type { DB } from "../db.js";
import { logger } from "../../log.js";
import { getAutoWake, getSetting, getTerminalSettings, setSetting } from "../app-settings.js";
import { getSession } from "../sessions.js";
import { AUTO_WAKE_PROMPT } from "./commands.js";
import { planClaudeWake } from "./claude.js";
import { planCodexWake } from "./codex.js";
import { launchWakeRun } from "./launcher.js";
import { tmuxAvailable, tmuxSessionAlive, tmuxInject, findTmuxSession } from "./tmux-inject.js";
import { resolveConfig } from "../../config.js";

/**
 * Wake a session so it processes its inbox:
 *   - active + busy  → skip: the running turn will surface the mail itself
 *   - offline        → headless `--resume` of the REAL conversation: full
 *     context, the reply lands in the actual history (visible in the CLI)
 *   - active + idle  → the open TUI holds codex's thread-store writer lock
 *     ("already has an active writer" — resume is refused), so a FRESH
 *     headless run answers instead, seeded with the target's real
 *     conversation digest extracted from its rollout. The reply reaches the
 *     asker via reply_ask; it lives in Conflux + the wake run's own
 *     rollout, not in the locked thread.
 *
 * Guards: auto_wake opt-in, CLI conversations only, dedup within
 * AUTO_WAKE_DEDUP_MS. dryRun previews the command without spawning.
 */

const AUTO_WAKE_DEDUP_MS = 90_000;

export type WakeResult =
  | { woke: true; command?: string }
  | { woke: false; reason: string };

export function wakeSessionForMail(
  db: DB,
  sessionId: string,
  opts: { dryRun?: boolean; now?: Date; claudeHome?: string } = {},
): WakeResult {
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

  // #128: if the target runs in a Conflux-managed tmux session, inject the
  // prompt into the LIVE process — no headless zombie. The live process
  // answers with its CURRENT context, exactly like the user typed it.
  const sessionMeta = (() => {
    try { return JSON.parse(session.metadata ?? "{}") as { agent_id?: unknown }; }
    catch { return {}; }
  })();
  const tmuxTarget = findTmuxSession(sessionMeta) ?? sessionId;
  if (!opts.dryRun && tmuxAvailable() && tmuxSessionAlive(tmuxTarget)) {
    const injected = tmuxInject(
      tmuxTarget,
      "你收到一条来自其他会话的消息,请用 Conflux 的 check_inbox 查看,用 reply_ask 回复后结束本轮。",
    );
    if (injected) {
      setSetting(db, `auto-wake:${sessionId}`, new Date(now).toISOString());
      return { woke: true };
    }
    // injection failed — fall through to headless resume
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

function wakeExe(db: DB, runtime: "claude" | "codex"): string {
  const settings = getTerminalSettings(db);
  return runtime === "codex"
    ? process.env.CODEX_PATH || settings.codex_path
    : process.env.CLAUDE_PATH || settings.claude_path;
}
