import type { RuntimeId } from "@muiltchat/shared";

/**
 * Single source of truth for "which OS processes belong to which CLI
 * runtime". Before this module, the token lists lived in three places that
 * had already drifted (liveness.ts's JS matcher, wake/launcher.ts's
 * PowerShell descendant matcher, live.ts's ancestor-walk script — the last
 * still embeds its own copy, see the note there).
 *
 * Consumers:
 *  - isRuntimeCommand(): token/basename matching for a FULL command line
 *    (process probing, POSIX ancestor walks);
 *  - psMatchClauses(): PowerShell Where-Object clause for descendant
 *    discovery (codex wake pid pinning).
 */

export const RUNTIME_TOKENS: Record<"claude" | "codex", string[]> = {
  claude: ["claude", "claude.exe", "claude.cmd", "@anthropic-ai/claude-code", "claude-code"],
  codex: ["codex", "codex.exe", "codex.cmd", "@openai/codex", "codex-cli"],
};

/** Does this command line belong to the selected runtime process? */
export function isRuntimeCommand(command: string, runtime: RuntimeId): boolean {
  const tokens = command.match(/"[^"]+"|\S+/g) ?? [];
  return tokens.some((t) => {
    const token = t.toLowerCase().replace(/^"|"$/g, "");
    const normalized = token.replace(/\\/g, "/");
    const basename = normalized.split("/").pop() ?? "";
    return RUNTIME_TOKENS[runtime].some((candidate) => {
      if (candidate.includes("/") || candidate.includes("-")) {
        // path-shaped tokens (@openai/codex) AND dashed package names
        // (codex-cli) match as a bounded path segment, never as a
        // substring — my-codex-notes.md is not a Codex process
        const re = new RegExp("(?:^|/)" + candidate + "(?:/|$)");
        return re.test(normalized);
      }
      // bare names match only as the command's basename
      return basename === candidate;
    });
  });
}

/**
 * PowerShell matcher clause for processes of this runtime: executable-name
 * equality plus command-line substring hits for every token (path separators
 * in tokens broaden to `*` so both / and \ match).
 */
export function psMatchClauses(runtime: RuntimeId): string {
  const tokens = RUNTIME_TOKENS[runtime];
  const nameChecks = tokens
    .filter((t) => t.endsWith(".exe"))
    .map((t) => `$_.Name -eq '${t}'`);
  const cmdChecks = tokens
    .filter((t) => !t.endsWith(".exe"))
    .map((t) => `$_.CommandLine -like '*${t.split("/").join("*")}*'`);
  return [...nameChecks, ...cmdChecks].join(" -or ");
}
