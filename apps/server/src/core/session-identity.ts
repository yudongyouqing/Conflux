import type { IdentitySource, SessionRuntime } from "@muiltchat/shared";

/** Parse values crossing the SQLite/metadata boundary into shared types. */
export function parseSessionRuntime(value: unknown): SessionRuntime | null {
  return value === "claude" || value === "codex" || value === "internal" || value === "web"
    ? value
    : null;
}

export function parseIdentitySource(value: unknown): IdentitySource | null {
  return value === "hook" || value === "mcp" || value === "http" || value === "cli" || value === "internal"
    ? value
    : null;
}

export function parseRuntimePid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
