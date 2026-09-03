import { hasTranscript } from "../live.js";
import { freshWakeCommand, wakeCommand } from "./commands.js";

/**
 * Claude wake policy. Claude Code passes a full environment to its MCP
 * children, so the launcher's MUILTCHAT_ASSUME_SESSION is how a headless
 * run adopts the target identity — no pid pinning needed.
 */

export interface ClaudeWakePlanInput {
  sessionId: string;
  exe: string;
  /** offline = the TUI is closed → resume the real conversation */
  offline: boolean;
  projectDir: string | null;
  claudeHome?: string;
}

export type WakePlan = { command: string; prompt?: string } | { refuse: string };

export function planClaudeWake(input: ClaudeWakePlanInput): WakePlan {
  if (input.offline) {
    // `claude --resume` needs the transcript file — claude only writes it
    // on the first turn, so zero-turn conversations cannot be woken (they
    // have no context to answer from anyway).
    if (!hasTranscript(input.sessionId, input.projectDir, input.claudeHome)) {
      return { refuse: "no transcript (zero-turn conversation)" };
    }
    return { command: wakeCommand("claude", input.sessionId, input.exe) };
  }
  // online + idle: a fresh run is fine for claude (no thread lock), but we
  // keep the resume form when possible — full context, real history.
  if (hasTranscript(input.sessionId, input.projectDir, input.claudeHome)) {
    return { command: wakeCommand("claude", input.sessionId, input.exe) };
  }
  return { command: freshWakeCommand("claude", input.exe) };
}
