import { randomUUID } from "node:crypto";
import type { ManagedConnection } from "../managed/adapter.js";
import {
  RPC_DEFAULT_TIMEOUT_MS,
  RPC_MAX_FRAME_BYTES,
  RpcClosedError,
  RpcFrameError,
  RpcRemoteError,
  RpcTimeoutError,
  type RpcHandlers,
  type RpcOptions,
  type RpcTransport,
} from "../managed-codex/rpc.js";

/**
 * Bidirectional NDJSON stream-json + SDK control-protocol connection for
 * Claude Code (`claude -p --input-format stream-json --output-format stream-json
 * --verbose --permission-prompts host`).
 *
 * Implements ManagedConnection so ManagedExecutor can drive Claude Code with
 * the exact same scheduling, approval-generation, interrupt, and recovery
 * state machine as Codex.
 */

interface PendingControl {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

let claudeGenCounter = 0;

export class ClaudeStreamConnection implements ManagedConnection {
  readonly generation = ++claudeGenCounter;

  private readonly transport: RpcTransport;
  private readonly handlers: RpcHandlers;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;

  private buffer = "";
  private closed = false;
  private seq = 0;
  private pending = new Map<string, PendingControl>();
  private pendingToolInputs = new Map<string, Record<string, unknown>>();
  private observedSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private interruptRequested = false;

  constructor(transport: RpcTransport, handlers: RpcHandlers = {}, options: RpcOptions = {}) {
    this.transport = transport;
    this.handlers = handlers;
    this.requestTimeoutMs = options.requestTimeoutMs ?? RPC_DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? RPC_MAX_FRAME_BYTES;
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (this.closed) throw new RpcClosedError();
    this.transport.write(JSON.stringify(frame) + "\n");
  }

  private sendControlRequest(request: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    const requestId = `cfx_req_${++this.seq}_${randomUUID().slice(0, 8)}`;
    return new Promise((resolve, reject) => {
      const entry: PendingControl = { resolve, reject };
      if (this.requestTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new RpcTimeoutError(String(request.subtype ?? "control_request"), this.requestTimeoutMs));
        }, this.requestTimeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(requestId, entry);
      try {
        this.sendFrame({
          type: "control_request",
          request_id: requestId,
          request,
        });
      } catch (err) {
        this.pending.delete(requestId);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new RpcClosedError();
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "initialize") {
      const res = (await this.sendControlRequest({ subtype: "initialize" })) as Record<
        string,
        unknown
      > | null;
      if (res && typeof res.session_id === "string" && res.session_id) {
        this.observedSessionId = res.session_id;
      }
      return {
        ...(res ?? {}),
        session_id: this.observedSessionId ?? (typeof res?.session_id === "string" ? res.session_id : null),
      };
    }

    if (method === "session/start") {
      const configured = typeof p.sessionId === "string" && p.sessionId ? p.sessionId : null;
      const sid = this.observedSessionId ?? configured ?? randomUUID();
      this.observedSessionId = sid;
      return { session_id: sid };
    }

    if (method === "session/resume") {
      const requested = typeof p.threadId === "string" ? p.threadId : "";
      const observed = this.observedSessionId;
      if (observed && requested && observed !== requested) {
        throw new Error(`claude resume returned a different session: ${observed}`);
      }
      const sid = observed ?? requested;
      if (!sid) throw new Error("claude resume requires a session id");
      this.observedSessionId = sid;
      return { session_id: sid };
    }

    if (method === "turn/start") {
      const text = typeof p.text === "string" ? p.text : "";
      const turnId = `claude-turn-${++this.seq}-${randomUUID().slice(0, 8)}`;
      this.activeTurnId = turnId;
      this.interruptRequested = false;
      this.sendFrame({
        type: "user",
        message: { role: "user", content: text },
        ...(this.observedSessionId ? { session_id: this.observedSessionId } : {}),
        parent_tool_use_id: null,
      });
      return { turnId };
    }

    if (method === "turn/steer") {
      if (!this.activeTurnId) {
        return { accepted: false, reason: "no active turn" };
      }
      const text = typeof p.text === "string" ? p.text : "";
      this.sendFrame({
        type: "user",
        message: { role: "user", content: text },
        priority: "next",
        ...(this.observedSessionId ? { session_id: this.observedSessionId } : {}),
        parent_tool_use_id: null,
      });
      return { accepted: true };
    }

    if (method === "turn/interrupt") {
      this.interruptRequested = true;
      await this.sendControlRequest({ subtype: "interrupt" });
      return { ok: true };
    }

    throw new Error(`unsupported claude stream method: ${method}`);
  }

  respond(id: number | string, result: unknown): void {
    const requestId = String(id);
    const payload = (result ?? {}) as {
      decision?: string;
      message?: string;
      answers?: Record<string, string | string[]>;
    };
    const decision = payload.decision;
    const originalInput = this.pendingToolInputs.get(requestId) ?? {};
    this.pendingToolInputs.delete(requestId);

    const updatedInput =
      payload.answers && Object.keys(payload.answers).length > 0
        ? { ...originalInput, answers: payload.answers }
        : originalInput;

    const responseBody =
      decision === "accept"
        ? { behavior: "allow", updatedInput }
        : {
            behavior: "deny",
            message:
              payload.message ??
              (decision === "cancel" ? "Cancelled by user in Conflux" : "Declined by user in Conflux"),
          };

    this.sendFrame({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: responseBody,
      },
    });
  }

  respondError(id: number | string, _code: number, message: string): void {
    const requestId = String(id);
    this.pendingToolInputs.delete(requestId);
    this.sendFrame({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: message,
      },
    });
  }

  handleChunk(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      const err = new RpcFrameError(`frame exceeded ${this.maxFrameBytes} bytes`);
      this.handlers.onProtocolError?.(err.message);
      this.close(err);
      return;
    }
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
      if (this.closed) return;
      idx = this.buffer.indexOf("\n");
    }
  }

  handleEnd(): void {
    if (this.closed) return;
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.handleLine(tail);
    this.close(new RpcClosedError("claude stream ended"));
  }

  close(error: Error = new RpcClosedError()): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.pendingToolInputs.clear();
    try {
      this.transport.close();
    } catch {
      // ignore teardown errors
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      this.handlers.onProtocolError?.("malformed JSON line from claude");
      return;
    }

    if (typeof msg.session_id === "string" && msg.session_id) {
      this.observedSessionId = msg.session_id;
    }

    // 1. Response to our outgoing control_request (initialize / interrupt)
    if (msg.type === "control_response" && msg.response && typeof msg.response === "object") {
      const resp = msg.response as Record<string, unknown>;
      const reqId = typeof resp.request_id === "string" ? resp.request_id : null;
      if (!reqId) return;
      const entry = this.pending.get(reqId);
      if (!entry) return;
      this.pending.delete(reqId);
      if (entry.timer) clearTimeout(entry.timer);
      if (resp.subtype === "error") {
        entry.reject(new RpcRemoteError(-32000, String(resp.error ?? "control error"), resp));
      } else {
        entry.resolve(resp.response ?? {});
      }
      return;
    }

    // 2. Incoming server-initiated control_request (e.g. can_use_tool approval)
    if (msg.type === "control_request" && msg.request && typeof msg.request === "object") {
      const reqId = typeof msg.request_id === "string" ? msg.request_id : null;
      const req = msg.request as Record<string, unknown>;
      const subtype = typeof req.subtype === "string" ? req.subtype : "unknown";
      if (!reqId) return;
      if (subtype === "can_use_tool") {
        const rawInput =
          req.input && typeof req.input === "object" && !Array.isArray(req.input)
            ? (req.input as Record<string, unknown>)
            : {};
        this.pendingToolInputs.set(reqId, rawInput);
      }
      this.handlers.onServerRequest?.(reqId, `claude/${subtype}`, {
        ...req,
        threadId: this.observedSessionId ?? undefined,
        turnId: this.activeTurnId ?? undefined,
      });
      return;
    }

    // 3. Streamed turn notifications (assistant / user tool_result / result / system)
    if (msg.type === "assistant") {
      this.handlers.onNotification?.("claude/assistant", {
        ...msg,
        turnId: this.activeTurnId,
      });
      return;
    }

    if (msg.type === "user") {
      this.handlers.onNotification?.("claude/user", {
        ...msg,
        turnId: this.activeTurnId,
      });
      return;
    }

    if (msg.type === "result") {
      const turnId = this.activeTurnId;
      const interrupted = this.interruptRequested;
      this.activeTurnId = null;
      this.interruptRequested = false;
      this.handlers.onNotification?.("claude/result", {
        ...msg,
        turnId,
        interrupted,
      });
      return;
    }

    if (msg.type === "system") {
      this.handlers.onNotification?.("claude/system", {
        ...msg,
        turnId: this.activeTurnId,
      });
    }
  }
}
