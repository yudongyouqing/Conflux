import type { RuntimeId } from "@conflux/shared";
import type { ThreadLaunchSpec } from "../runtime-env.js";
import type { RpcHandlers, RpcOptions, RpcTransport } from "../managed-codex/rpc.js";
import type { ApprovalDecision, ApprovalKind, ApprovalResponseExtra } from "../managed-codex/approvals.js";

/**
 * Runtime protocol contract driven by the unified ThreadManager (`core/threads/executor.ts`).
 * Codex app-server, Claude stream-json, and ACP (Antigravity `agy acp` + generic ACP)
 * all implement this single interface.
 */

export interface AdapterConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  respondError?(id: number | string, code: number, message: string, data?: unknown): void;
}

export interface ManagedConnection extends AdapterConnection {
  readonly generation: number;
  handleChunk(chunk: string): void;
  handleEnd(): void;
  close(error?: Error): void;
}

export interface ManagedLaunchOptions {
  resumeThreadId?: string;
}

export interface ManagedLaunchConfig {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface NormalizedHistoryTurn {
  turnId: string;
  status: "completed" | "failed" | "interrupted" | string;
  errorMessage: string | null;
  finalText: string | null;
}

export type ManagedEventType = "text" | "thinking" | "tool" | "approval" | "status" | "error";

export interface NormalizedNotification {
  type: ManagedEventType;
  payload: Record<string, unknown>;
  turnId: string | null;
  agentText: string | null;
  turnCompleted: {
    turnId: string | null;
    status: string;
    errorMessage: string | null;
  } | null;
}

export type CanonicalApprovalKind = ApprovalKind;
export type { ApprovalDecision, ApprovalResponseExtra, ThreadLaunchSpec };

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
  threadId?: string;
}

export interface RuntimeAdapter {
  readonly runtime: RuntimeId;
  readonly label: string;

  defaultLaunch(db: unknown, spec: ThreadLaunchSpec, opts?: ManagedLaunchOptions): ManagedLaunchConfig;

  createConnection?(
    transport: RpcTransport,
    handlers: RpcHandlers,
    options?: RpcOptions,
  ): ManagedConnection;

  initialize(conn: AdapterConnection): Promise<void>;

  startThread(
    conn: AdapterConnection,
    spec: ThreadLaunchSpec,
    cwd: string,
    ctx?: ManagedSessionContext,
  ): Promise<string>;

  resumeThread(
    conn: AdapterConnection,
    spec: ThreadLaunchSpec,
    providerThreadId: string,
    ctx?: ManagedSessionContext,
  ): Promise<{ threadId: string; turns: NormalizedHistoryTurn[] }>;

  startTurn(
    conn: AdapterConnection,
    providerThreadId: string,
    input: { text: string; clientMessageId?: string | number },
  ): Promise<string>;

  steerTurn?(
    conn: AdapterConnection,
    providerThreadId: string,
    turnId: string,
    input: { text: string; clientMessageId?: string | number },
  ): Promise<{ accepted: boolean; reason?: string }>;

  /** Optional live same-engine model switch without restarting the child process. */
  setModel?(conn: AdapterConnection, providerThreadId: string, model: string): Promise<boolean>;

  interrupt(conn: AdapterConnection, providerThreadId: string, turnId: string): Promise<void>;

  formatApprovalResponse?(decision: ApprovalDecision, extra?: ApprovalResponseExtra): unknown;

  respond(conn: AdapterConnection, rpcId: number | string, result: unknown): void;

  classifyServerRequest(
    method: string,
    params: unknown,
    ctx: { threadId: string; activeTurnId: string | null },
  ): ServerRequestClassification;

  normalizeNotification(method: string, params: unknown): NormalizedNotification | null;
}
