import { join } from "node:path";
import { readdirSync } from "node:fs";
import { codexRolloutDigest } from "../codex-titles.js";
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

export type WakePlanCodex = { command: string; prompt?: string } | { refuse: string };

/** Locate the rollout jsonl for a codex conversation uuid (filename suffix). */
export function findCodexRolloutPath(codexSessionId: string): string {
  try {
    const root = join(
      (process.env.USERPROFILE || process.env.HOME || ".") + "/.codex/sessions"
    );
    // day dirs from 30d back to today; the filename embeds the uuid
    for (let t = Date.now() - 30 * 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
      const d = new Date(t);
      const p2 = (n: number) => String(n).padStart(2, "0");
      const dir = join(root, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const hit = files.find((f) => f.endsWith(codexSessionId + ".jsonl"));
      if (hit) return join(dir, hit);
    }
  } catch {
    // fall through
  }
  return "";
}

// re-export for the dispatcher's offline prompt (codex offline wakes use
// the plain prompt — the resumed thread carries its own context)
export { AUTO_WAKE_PROMPT };
