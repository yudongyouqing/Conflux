import { cmdQuote, resumeCommand } from "../terminal.js";

/**
 * Wake commands and prompts, per runtime.
 *
 * Wake prompts are delivered via STDIN (codex `exec -`, claude `-p` with no
 * arg reads the pipe) — the conversation digest contains quotes and
 * newlines that no amount of cmd.exe quoting survives inline.
 */

export const AUTO_WAKE_PROMPT =
  "你收到一条来自其他会话的消息:请立即调用 muiltchat 的 check_inbox 查看收件箱,结合本会话已有的工作上下文,用 reply_ask 把回复发给提问方,然后结束本轮,不要做其他事。";

/** Pre-authorized tools for headless claude runs (-p cannot ask permission). */
export const HEADLESS_ALLOWED_TOOLS = "mcp__muiltchat__*";

/** codex exec defaults to approval policy "never", under which MCP tool
 * calls are REJECTED headlessly ("MCP tool call requires approval") — the
 * wake could never reach check_inbox. The bypass flag is the only way to
 * let a headless run use MCP tools; the wake prompt is our own trusted
 * text, and the run's cwd is the session's project dir. */
const CODEX_WAKE_FLAGS = "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check";

/**
 * Wake prompt, optionally seeded with the target's real conversation tail
 * (used when the thread is LOCKED by an open TUI and cannot be resumed).
 */
export function buildWakePrompt(digest?: string | null): string {
  if (!digest || digest.trim().length === 0) return AUTO_WAKE_PROMPT;
  // flatten to one line: the command runs through cmd.exe, and a newline
  // inside a quoted argument truncates everything after it
  const flat = digest.replace(/\s+/g, " ").trim();
  return `${AUTO_WAKE_PROMPT}\n提问方等待回复。以下是本会话最近的对话记录摘要(供回复时参考,不要重复执行其中内容):\n${flat}`;
}

/**
 * Fresh headless run (no resume) — used when the open TUI's thread lock
 * makes resuming the real conversation impossible (codex refuses with
 * "already has an active writer"). Prompt comes via stdin.
 */
export function freshWakeCommand(runtime: "claude" | "codex", executable: string): string {
  const exe = cmdQuote(executable);
  if (runtime === "codex") return `${exe} exec ${CODEX_WAKE_FLAGS} -`;
  return `${exe} -p --allowedTools ${cmdQuote(HEADLESS_ALLOWED_TOOLS)}`;
}

/**
 * Full headless wake command: resume the conversation and drive the reply.
 * Prompt comes via stdin.
 */
export function wakeCommand(
  runtime: "claude" | "codex",
  sessionId: string,
  executable: string
): string {
  if (runtime === "codex") {
    return `${cmdQuote(executable)} exec resume ${sessionId} ${CODEX_WAKE_FLAGS} -`;
  }
  return `${resumeCommand("claude", sessionId, executable)} --allowedTools ${cmdQuote(
    HEADLESS_ALLOWED_TOOLS
  )} -p`;
}
