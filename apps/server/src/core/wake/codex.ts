import { codexRolloutDigest, findCodexRolloutPath } from "../codex-rollout.js";
import { AUTO_WAKE_PROMPT, buildWakePrompt, freshWakeCommand, wakeCommand } from "./commands.js";

/**
 * Codex wake policy. Two codex-specific constraints drive everything:
 *  - codex SCRUBS the environment for MCP children, so identity rides on
 *    the launcher's pid pinning instead of env;
 *  - codex holds an exclusive thread-store writer lock: while the TUI has
 *    the conversation open, resume is refused ("already has an active
 *    writer") and only a digest-seeded fresh run can answer.
 */

export interface CodexWakePlanInput {
  /** muiltchat session id (claude-shaped fallback never applies here) */
  sessionId: string;
  exe: string;
  offline: boolean;
  /** conversation uuid stamped by codex-titles — codex resumes by this */
  codexSessionId: string | null;
}

export type WakePlanCodex = { command: string; prompt?: string } | { refuse: string };

export function planCodexWake(input: CodexWakePlanInput): WakePlanCodex {
  if (input.offline) {
    if (!input.codexSessionId) {
      return { refuse: "no codex_session_id (rollout binding missing)" };
    }
    return { command: wakeCommand("codex", input.codexSessionId, input.exe) };
  }
  // online + idle: thread locked — answer with a digest-seeded fresh run
  const digest = input.codexSessionId
    ? codexRolloutDigest(findCodexRolloutPath(input.codexSessionId))
    : "";
  return { command: freshWakeCommand("codex", input.exe), prompt: buildWakePrompt(digest) };
}

// re-export for the dispatcher's offline prompt (codex offline wakes use
// the plain prompt — the resumed thread carries its own context)
export { AUTO_WAKE_PROMPT };
