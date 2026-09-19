import {
  DEFAULT_SESSION_PRIORITY,
  type IdentitySource,
  type SessionPriority,
  type SessionRuntime,
} from "@conflux/shared";

/** Parse values crossing the SQLite/metadata boundary into shared types. */
export function parseSessionRuntime(value: unknown): SessionRuntime | null {
  return value === "claude" || value === "codex" || value === "internal" || value === "web"
    ? value
    : null;
}

export function parseSessionPriority(value: unknown): SessionPriority {
  return value === "P0" || value === "P1" || value === "P2" ? value : DEFAULT_SESSION_PRIORITY;
}

export function parseIdentitySource(value: unknown): IdentitySource | null {
  return value === "hook" ||
    value === "mcp" ||
    value === "http" ||
    value === "cli" ||
    value === "internal"
    ? value
    : null;
}

export function parseRuntimePid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
