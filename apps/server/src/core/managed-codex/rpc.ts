/**
 * JSONL JSON-RPC framing and request correlation for the Codex app-server
 * stdio transport. One ManagedRpcConnection owns ONE process stream; a
 * reconnect builds a new connection (new generation, fresh id space), so
 * bytes left over on a dead stream can never settle a new connection's
 * promises. All limits are per connection: frame size, in-flight requests,
 * and the per-request timeout default.
 */

export const RPC_DEFAULT_TIMEOUT_MS = 30_000;
export const RPC_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const RPC_MAX_IN_FLIGHT = 128;

export interface RpcTransport {
  /** Send one serialized frame to the peer. */
  write(frame: string): void;
  /** Tear the transport down (used when the connection fails hard). */
  close(): void;
}

export interface RpcHandlers {
  onNotification?(method: string, params: unknown): void;
  /** Server-initiated request (e.g. approvals) awaiting respond(). */
  onServerRequest?(id: number | string, method: string, params: unknown): void;
  /** Malformed line/frame; the connection stays usable unless it failed hard. */
  onProtocolError?(message: string): void;
}

export interface RpcOptions {
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maxInFlight?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class RpcClosedError extends Error {
  readonly code = "RPC_CLOSED";
  constructor(reason = "connection closed") {
    super(reason);
    this.name = "RpcClosedError";
  }
}

export class RpcTimeoutError extends Error {
  readonly code = "RPC_TIMEOUT";
  constructor(method: string, ms: number) {
    super(`request timed out after ${ms}ms: ${method}`);
    this.name = "RpcTimeoutError";
  }
}

export class RpcFrameError extends Error {
  readonly code = "RPC_FRAME";
  constructor(message: string) {
    super(message);
    this.name = "RpcFrameError";
  }
}

export class RpcInFlightLimitError extends Error {
  readonly code = "RPC_IN_FLIGHT";
  constructor(max: number) {
    super(`too many in-flight requests (limit ${max})`);
    this.name = "RpcInFlightLimitError";
  }
}

/** A JSON-RPC error response from the peer, surfaced as a rejected request. */
export class RpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "RpcRemoteError";
    this.code = code;
    this.data = data;
  }
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function detachAbort(entry: PendingEntry): void {
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
}

let generationCounter = 0;

export class ManagedRpcConnection {
  /** Monotonic per-process generation; tags callbacks to this connection. */
  readonly generation: number = ++generationCounter;

  private readonly transport: RpcTransport;
  private readonly handlers: RpcHandlers;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxInFlight: number;

  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private buffer = "";
  private closed = false;

  constructor(transport: RpcTransport, handlers: RpcHandlers = {}, options: RpcOptions = {}) {
    this.transport = transport;
    this.handlers = handlers;
    this.requestTimeoutMs = options.requestTimeoutMs ?? RPC_DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? RPC_MAX_FRAME_BYTES;
    this.maxInFlight = options.maxInFlight ?? RPC_MAX_IN_FLIGHT;
  }

  /** Send a client request; resolves with the peer's `result`. */
  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    if (this.pending.size >= this.maxInFlight) {
      return Promise.reject(new RpcInFlightLimitError(this.maxInFlight));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingEntry = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      if (options.signal) {
        const signal = options.signal;
        entry.signal = signal;
        entry.onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(Object.assign(new Error(`request aborted: ${method}`), { name: "AbortError" }));
        };
        if (signal.aborted) {
          entry.onAbort();
          return;
        }
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Answer a server-initiated request with a result object. */
  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  /** Feed raw bytes from the peer's stdout. */
  handleChunk(chunk: string | Buffer): void {
    if (this.closed) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line.replace(/\r$/, ""));
      if (this.closed) return;
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxFrameBytes) {
      this.failAll(new RpcFrameError(`frame exceeds ${this.maxFrameBytes} bytes`));
    }
  }

  /** The peer's stdout ended without more bytes. */
  handleEnd(): void {
    if (this.closed) return;
    if (this.buffer.trim().length > 0) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.handleLine(line);
    }
    this.failAll(new RpcClosedError("stream ended"));
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    if (line.length > this.maxFrameBytes) {
      this.failAll(new RpcFrameError(`frame exceeds ${this.maxFrameBytes} bytes`));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.handlers.onProtocolError?.(`invalid JSON line (${line.length} bytes)`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.handlers.onProtocolError?.("frame is not a JSON-RPC object");
      return;
    }
    const frame = parsed as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (typeof frame.method === "string") {
      if (frame.id === undefined || frame.id === null) {
        // Unknown notification methods are future protocol surface — record
        // and continue rather than dying on version skew.
        this.handlers.onNotification?.(frame.method, frame.params);
      } else {
        this.handlers.onServerRequest?.(frame.id as number | string, frame.method, frame.params);
      }
      return;
    }
    if (frame.id === undefined || frame.id === null) {
      this.handlers.onProtocolError?.("frame has neither method nor id");
      return;
    }
    const id = frame.id as number;
    const entry = this.pending.get(id);
    if (!entry) return; // late response after timeout/abort — nothing to do
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    detachAbort(entry);
    if (frame.error) {
      const code = typeof frame.error.code === "number" ? frame.error.code : 0;
      const message = typeof frame.error.message === "string" ? frame.error.message : "rpc error";
      entry.reject(new RpcRemoteError(code, message, frame.error.data));
    } else {
      entry.resolve(frame.result);
    }
  }

  /** Close the connection, rejecting every pending request. Idempotent. */
  close(reason?: Error): void {
    this.failAll(reason ?? new RpcClosedError());
  }

  private failAll(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      detachAbort(entry);
      entry.reject(reason);
    }
    this.pending.clear();
    this.transport.close();
  }
}
