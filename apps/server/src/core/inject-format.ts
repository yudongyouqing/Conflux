/**
 * Machine-injected prompt text: one badge format, one flattening rule (#162).
 *
 * Everything Conflux types into a session (tmux send-keys now, PTY write
 * later) must be identifiable at a glance as machine-delivered — the badge
 * prefix says what and from whom. The single-line rule exists because
 * send-keys types literal characters: a newline in the payload submits the
 * input early, so multi-line bodies are flattened before typing.
 */

export interface BadgeInput {
  /** what this injection is, e.g. 回复 / 提问 / 聊天室任务 */
  label: string;
  /** originating session's display name */
  from?: string;
  /** stable handle for follow-up, e.g. "msg #42" */
  ref?: string;
}

/** `[Conflux·回复 ← web-console · msg #42]` */
export function badge(input: BadgeInput): string {
  const parts = [input.label];
  if (input.from) parts.push(`← ${input.from}`);
  if (input.ref) parts.push(`· ${input.ref}`);
  return `[Conflux·${parts.join(" ")}]`;
}

/** Collapse all whitespace runs (newlines included) to single spaces. */
export function flattenOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cap length, pointing at the full text — mirrors the hook-notice wording. */
export function truncateForTyping(text: string, limit: number, more: string): string {
  return text.length <= limit ? text : text.slice(0, limit) + `…(截断，${more})`;
}
