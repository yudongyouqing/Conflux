/**
 * Conflux-side contract for the managed Codex executor. These types are the
 * server's OWN normalized vocabulary (DB rows, scheduler input, replayable
 * events); they deliberately do not mirror the full app-server RPC schema —
 * wire structs are validated at the rpc/process boundary against the
 * protocol version the manager negotiated at initialize.
 */

/**
 * Lifecycle of one managed task execution. Terminal: completed / failed /
 * interrupted. `unknown` marks the crash window where a turn may or may not
 * have been started — it requires explicit reconciliation, never replay.
 */
export type ManagedRunState =
  | "queued"
  | "submitting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export const MANAGED_RUN_TERMINAL_STATES: readonly ManagedRunState[] = [
  "completed",
  "failed",
  "interrupted",
];

/** One managed instance owns exactly one root thread in one app-server. */
export interface ManagedCodexBinding {
  instanceId: string;
  sessionId: string;
  threadId: string;
}

/** Input for enqueueing a task; `text` is the exact prompt snapshot to send. */
export interface ManagedTaskInput {
  messageId: number;
  instanceId: string;
  text: string;
}

/** Normalized, replayable execution event (no raw reasoning or credentials). */
export interface ManagedCodexEvent {
  sequence: number;
  instanceId: string;
  runId: string | null;
  threadId: string | null;
  turnId: string | null;
  type: "text" | "tool" | "approval" | "status" | "error";
  payload: Record<string, unknown>;
}
