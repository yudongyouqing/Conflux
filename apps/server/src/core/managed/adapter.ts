import type { RuntimeAgent } from "@conflux/shared";
import type { RpcHandlers, RpcOptions, RpcTransport } from "../managed-codex/rpc.js";
import type { ApprovalDecision, ApprovalKind, ApprovalResponseExtra } from "../managed-codex/approvals.js";

/**
 * The runtime contract a managed executor speaks. Everything protocol-shaped
 * (method names, parameter fields, frame normalization, history parsing,
 * handshake gating) lives behind this interface so the executor core in
 * executor.ts stays runtime-agnostic: Codex app-server, Claude stream-json,
 * and ACP (Antigravity `agy acp` and any ACP-compliant CLI) all implement it.
 */

/** Structural slice of the stdio connection an adapter drives. */
export interface AdapterConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  respondError?(id: number | string, code: number, message: string, data?: unknown): void;
}

/** Full stdio connection contract managed by spawnAppServer. */
export interface ManagedConnection extends AdapterConnection {
  readonly generation: number;
  handleChunk(chunk: string): void;
  handleEnd(): void;
  close(error?: Error): void;
}

export interface ManagedLaunchOptions {
  /** Present when spawning a child to rejoin a saved thread/session. */
  resumeThreadId?: string;
}

/** Launch description for the runtime's app-server-shaped child. */
export interface ManagedLaunchConfig {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** One turn from the saved thread history, normalized for reconciliation. */
export interface NormalizedHistoryTurn {
  turnId: string;
  /** Canonical terminal statuses the executor reconciles against. */
  status: "completed" | "failed" | "interrupted" | string;
  errorMessage: string | null;
  /** Merged final agent text (null when the turn produced none). */
  finalText: string | null;
}

/** The executor's persisted event surface (same union the UI streams). */
export type ManagedEventType = "text" | "tool" | "approval" | "status" | "error";

/** A runtime notification in executor terms (null = not interesting). */
export interface NormalizedNotification {
  /** Event type persisted for the UI stream. */
  type: ManagedEventType;
  payload: Record<string, unknown>;
  /** The protocol's own turn id when the frame carries one. */
  turnId: string | null;
  /** Completed agent-message text for the final-answer merge. */
  agentText: string | null;
  /** Present when the frame terminates the active turn. */
  turnCompleted: {
    turnId: string | null;
    status: string;
    errorMessage: string | null;
  } | null;
}

/** The executor's human-approval surface. Runtimes map their protocol
 *  requests onto these canonical kinds (identical union to the store's
 *  ApprovalKind so adapters feed it without casts). */
export type CanonicalApprovalKind = ApprovalKind;

export type { ApprovalDecision, ApprovalResponseExtra };

/** What the executor should do with a server-initiated request. */
export type ServerRequestClassification =
  | {
      kind: "approval";
      approvalKind: CanonicalApprovalKind;
      sanitized: Record<string, unknown>;
      turnId: string | null;
    }
  | { kind: "refuse"; reason: string };

export interface ManagedSessionContext {
  db?: unknown;
  instanceId?: string;
  sessionId?: string;
}

export interface RuntimeAdapter {
  /** The preset runtime this adapter drives (e.g. "codex", "claude", "antigravity", "acp"). */
  readonly runtime: RuntimeAgent["runtime"];
  /** Human label for session descriptions/logs (e.g. "Codex"). */
  readonly label: string;

  /** The default child launch when no test/injector overrides it. */
  defaultLaunch(db: unknown, agent: RuntimeAgent, opts?: ManagedLaunchOptions): ManagedLaunchConfig;

  /** Optional custom stdio connection factory (defaults to JSON-RPC 2.0). */
  createConnection?(
    transport: RpcTransport,
    handlers: RpcHandlers,
    options?: RpcOptions,
  ): ManagedConnection;

  /** Handshake: initialize + compatibility gate. Throws on refusal. */
  initialize(conn: AdapterConnection): Promise<void>;

  /** Create the root thread; resolves its protocol thread id. */
  startThread(
    conn: AdapterConnection,
    agent: RuntimeAgent,
    cwd: string,
    ctx?: ManagedSessionContext,
  ): Promise<string>;

  /** Rejoin a saved thread; resolves the thread id and its normalized
   *  history for crash reconciliation. Throws if the server rejoined a
   *  DIFFERENT thread than requested. */
  resumeThread(
    conn: AdapterConnection,
    agent: RuntimeAgent,
    threadId: string,
    ctx?: ManagedSessionContext,
  ): Promise<{ threadId: string; turns: NormalizedHistoryTurn[] }>;

  /** Start one turn; resolves its protocol turn id. */
  startTurn(
    conn: AdapterConnection,
    threadId: string,
    input: { text: string; clientMessageId?: string | number },
  ): Promise<string>;

  /** Optional: inject a steering message into an active turn without interrupting it. */
  steerTurn?(
    conn: AdapterConnection,
    threadId: string,
    turnId: string,
    input: { text: string; clientMessageId?: string | number },
  ): Promise<{ accepted: boolean; reason?: string }>;

  /** Interrupt the given turn. */
  interrupt(conn: AdapterConnection, threadId: string, turnId: string): Promise<void>;

  /** Optional: format the human approval decision into the protocol's reply shape. */
  formatApprovalResponse?(decision: ApprovalDecision, extra?: ApprovalResponseExtra): unknown;

  /** Answer a server request on the live connection (decision or error). */
  respond(conn: AdapterConnection, rpcId: number | string, result: unknown): void;

  /** Classify a server-initiated request: an approval ask (payload already
   *  sanitized for the human surface) or an explicit refusal. Mismatched
   *  thread/turn guards belong here so refusals carry the protocol's
   *  semantics. */
  classifyServerRequest(
    method: string,
    params: unknown,
    ctx: { threadId: string; activeTurnId: string | null },
  ): ServerRequestClassification;

  /** Normalize one notification; null when the runtime has nothing for us. */
  normalizeNotification(
    method: string,
    params: unknown,
  ): NormalizedNotification | null;
}
