import { randomUUID } from "node:crypto";
import type { ManagedConnection } from "../managed/adapter.js";
import {
  ManagedRpcConnection,
  RpcClosedError,
  type RpcHandlers,
  type RpcOptions,
  type RpcTransport,
} from "../managed-codex/rpc.js";

/**
 * Bidirectional JSON-RPC 2.0 connection adapter for ACP (Agent Client Protocol)
 * CLIs such as Antigravity (`agy acp`), GitHub Copilot (`copilot --acp`),
 * Cursor, and Kiro.
 *
 * ACP's `session/prompt` is a long-running RPC that resolves when the turn
 * completes while `session/update` notifications stream in the meantime.
 * This connection bridges ACP onto Conflux's non-blocking `ManagedConnection`
 * contract (`turn/start` returns a turn id immediately, and prompt settlement
 * emits a synthetic `acp/turn_completed` notification).
 */

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpInitializeInfo {
  protocolVersion?: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities?: Record<string, unknown>;
}

const OPEN_MODEL_ACCESS_VERSION: readonly [number, number, number] = [1, 5, 1];
const PROMPT_STEERING_VERSION: readonly [number, number, number] = [1, 5, 0];

function parseSemverTriple(version: string | null | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec((version ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverTriple(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function antigravitySupportsSystemPromptAppend(init: AcpInitializeInfo | null): boolean {
  const meta = (init?.agentCapabilities as { _meta?: unknown } | undefined)?._meta;
  if (!meta || typeof meta !== "object") return false;
  const agy = (meta as { antigravity?: unknown }).antigravity;
  if (!agy || typeof agy !== "object") return false;
  const sp = (agy as { systemPrompt?: unknown }).systemPrompt;
  return Boolean(sp && typeof sp === "object" && (sp as { append?: unknown }).append === true);
}

export function antigravitySupportsPromptSteering(init: AcpInitializeInfo | null): boolean {
  const ver = parseSemverTriple(init?.agentInfo?.version);
  if (!ver) return false;
  return compareSemverTriple(ver, PROMPT_STEERING_VERSION) >= 0;
}

export function antigravityClientInfo(version?: string | null): {
  name: string;
  title?: string;
  version: string;
} {
  const ver = parseSemverTriple(version);
  if (ver && compareSemverTriple(ver, OPEN_MODEL_ACCESS_VERSION) < 0) {
    // Older agy releases restrict non-Gemini models to allowlisted editor names.
    return { name: "zed", version: "0.0.0" };
  }
  return { name: "conflux", title: "Conflux", version: "0.3.1" };
}

export class AcpStreamConnection implements ManagedConnection {
  readonly generation: number;

  private readonly rpc: ManagedRpcConnection;
  private readonly handlers: RpcHandlers;
  private readonly runtime: string;
  private seq = 0;
  private sessionId: string | null = null;
  private activeTurnId: string | null = null;
  private cancelRequested = false;
  /** Accumulates streaming agent_message_chunk deltas for the active turn so
   *  turn completion delivers the full assembled message rather than the final chunk. */
  private turnChunkBuffer = "";
  private turnTextSegments: string[] = [];
  private initInfo: AcpInitializeInfo | null = null;
  /** Remember native permission options per pending server request id so
   *  simple accept/decline decisions can pick the exact native optionId. */
  private pendingPermissionOptions = new Map<string, AcpPermissionOption[]>();

  constructor(
    transport: RpcTransport,
    handlers: RpcHandlers = {},
    options: RpcOptions = {},
    runtime = "acp",
  ) {
    this.handlers = handlers;
    this.runtime = runtime;
    this.rpc = new ManagedRpcConnection(
      transport,
      {
        onNotification: (method, params) => this.handleInboundNotification(method, params),
        onServerRequest: (id, method, params) => this.handleInboundServerRequest(id, method, params),
        onProtocolError: (msg) => this.handlers.onProtocolError?.(msg),
      },
      options,
    );
    this.generation = this.rpc.generation;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "acp/initialize") {
      const initParams = {
        protocolVersion: 1,
        clientInfo:
          this.runtime === "antigravity"
            ? antigravityClientInfo(typeof p.runtimeVersion === "string" ? p.runtimeVersion : null)
            : { name: "conflux", title: "Conflux", version: "0.3.1" },
        // Keep fs.writeTextFile false: advertising writeTextFile causes agents
        // like agy to replace surgical diffs with full-file client writes.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      };
      const res = (await this.rpc.request("initialize", initParams)) as AcpInitializeInfo;
      this.initInfo = res ?? {};
      return this.initInfo;
    }

    if (method === "acp/session_new") {
      const cwd = typeof p.cwd === "string" ? p.cwd : process.cwd();
      const mcpServers = Array.isArray(p.mcpServers) ? p.mcpServers : [];
      const systemPrompt = typeof p.systemPrompt === "string" && p.systemPrompt.trim() ? p.systemPrompt.trim() : null;
      const meta =
        systemPrompt && antigravitySupportsSystemPromptAppend(this.initInfo)
          ? { antigravity: { systemPrompt: { append: systemPrompt } } }
          : undefined;
      const res = (await this.rpc.request("session/new", {
        cwd,
        mcpServers,
        ...(meta ? { _meta: meta } : {}),
      })) as { sessionId?: string };
      if (!res?.sessionId) throw new Error("ACP session/new returned no sessionId");
      this.sessionId = res.sessionId;
      if (typeof p.model === "string" && p.model.trim()) {
        await this.trySetSessionModel(res.sessionId, p.model.trim());
      }
      return res;
    }

    if (method === "acp/session_load") {
      const requested = typeof p.sessionId === "string" ? p.sessionId : "";
      if (!requested) throw new Error("ACP session/load requires sessionId");
      const cwd = typeof p.cwd === "string" ? p.cwd : process.cwd();
      const mcpServers = Array.isArray(p.mcpServers) ? p.mcpServers : [];
      const canLoad = Boolean(
        (this.initInfo?.agentCapabilities as { loadSession?: unknown } | undefined)?.loadSession === true,
      );
      if (canLoad) {
        await this.rpc.request("session/load", { sessionId: requested, cwd, mcpServers });
      } else {
        // Agents without loadSession start a fresh runtime bound to the saved id
        // only when session/resume is supported; otherwise fail clearly.
        await this.rpc.request("session/resume", { sessionId: requested, cwd, mcpServers });
      }
      this.sessionId = requested;
      return { sessionId: requested };
    }

    if (method === "acp/turn_start") {
      const sid = (typeof p.sessionId === "string" && p.sessionId) || this.sessionId;
      if (!sid) throw new Error("ACP turn/start called before session creation");
      const text = typeof p.text === "string" ? p.text : "";
      const turnId = `acp-turn-${++this.seq}-${randomUUID().slice(0, 8)}`;
      this.activeTurnId = turnId;
      this.cancelRequested = false;
      this.turnChunkBuffer = "";
      this.turnTextSegments = [];

      // ACP session/prompt stays pending until the entire turn finishes, so we
      // disable the short RPC timeout (0 = wait for turn completion) and emit
      // a normalized terminal notification when it settles.
      void this.rpc
        .request(
          "session/prompt",
          {
            sessionId: sid,
            prompt: [{ type: "text", text }],
          },
          { timeoutMs: 0 },
        )
        .then(
          (res) => {
            const out = (res ?? {}) as { stopReason?: string };
            const cancelled = this.cancelRequested || out.stopReason === "cancelled";
            let finalText: string | null = null;
            if (this.activeTurnId === turnId) {
              if (this.turnChunkBuffer.trim()) {
                this.turnTextSegments.push(this.turnChunkBuffer);
              }
              const lastSegment = this.turnTextSegments[this.turnTextSegments.length - 1];
              finalText = lastSegment ? lastSegment.trim() : null;
              this.turnChunkBuffer = "";
              this.turnTextSegments = [];
              this.activeTurnId = null;
              this.cancelRequested = false;
            }
            this.handlers.onNotification?.("acp/turn_completed", {
              turnId,
              status: cancelled ? "interrupted" : "completed",
              stopReason: out.stopReason ?? "end_turn",
              errorMessage: null,
              ...(finalText ? { finalText } : {}),
            });
          },
          (err) => {
            const cancelled = this.cancelRequested;
            if (this.activeTurnId === turnId) {
              this.turnChunkBuffer = "";
              this.turnTextSegments = [];
              this.activeTurnId = null;
              this.cancelRequested = false;
            }
            if (err instanceof RpcClosedError) return;
            this.handlers.onNotification?.("acp/turn_completed", {
              turnId,
              status: cancelled ? "interrupted" : "failed",
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          },
        );

      return { turnId };
    }

    if (method === "acp/turn_steer") {
      const sid = (typeof p.sessionId === "string" && p.sessionId) || this.sessionId;
      if (!sid || !this.activeTurnId) {
        return { accepted: false, reason: "no active turn" };
      }
      const supportsSteer =
        this.runtime === "antigravity"
          ? antigravitySupportsPromptSteering(this.initInfo)
          : Boolean(
              (this.initInfo?.agentCapabilities as { promptSteering?: unknown } | undefined)
                ?.promptSteering === true,
            );
      if (!supportsSteer) {
        return { accepted: false, reason: "ACP agent does not advertise prompt steering" };
      }
      const text = typeof p.text === "string" ? p.text : "";
      // On agy >= 1.5.0, sending a concurrent session/prompt steers the active turn.
      void this.rpc
        .request(
          "session/prompt",
          {
            sessionId: sid,
            prompt: [{ type: "text", text }],
          },
          { timeoutMs: 0 },
        )
        .catch(() => {
          // steer settlement errors are surfaced through normal turn stream
        });
      return { accepted: true };
    }

    if (method === "acp/set_model") {
      const sid = (typeof p.sessionId === "string" && p.sessionId) || this.sessionId;
      const model = typeof p.model === "string" ? p.model.trim() : "";
      if (!sid || !model) return { ok: false };
      const ok = await this.trySetSessionModel(sid, model);
      return { ok };
    }

    if (method === "acp/turn_cancel") {
      const sid = (typeof p.sessionId === "string" && p.sessionId) || this.sessionId;
      if (!sid) return { ok: true };
      this.cancelRequested = true;
      this.rpc.notify("session/cancel", { sessionId: sid });
      return { ok: true };
    }

    return this.rpc.request(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.rpc.notify(method, params);
  }

  respond(id: number | string, result: unknown): void {
    const key = String(id);
    const options = this.pendingPermissionOptions.get(key) ?? [];
    this.pendingPermissionOptions.delete(key);

    const payload = (result ?? {}) as {
      outcome?: unknown;
      decision?: string;
      optionId?: string;
    };

    // Already formatted ACP outcome passes through verbatim.
    if (payload.outcome && typeof payload.outcome === "object") {
      this.rpc.respond(id, { outcome: payload.outcome });
      return;
    }

    if (payload.optionId) {
      this.rpc.respond(id, { outcome: { outcome: "selected", optionId: payload.optionId } });
      return;
    }

    const decision = payload.decision;
    if (decision === "cancel") {
      this.rpc.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }

    const chosen = this.pickPermissionOption(options, decision === "accept");
    if (chosen) {
      this.rpc.respond(id, { outcome: { outcome: "selected", optionId: chosen.optionId } });
    } else {
      this.rpc.respond(id, { outcome: { outcome: "cancelled" } });
    }
  }

  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    this.pendingPermissionOptions.delete(String(id));
    this.rpc.respondError(id, code, message, data);
  }

  handleChunk(chunk: string): void {
    this.rpc.handleChunk(chunk);
  }

  handleEnd(): void {
    this.pendingPermissionOptions.clear();
    this.rpc.handleEnd();
  }

  close(error?: Error): void {
    this.pendingPermissionOptions.clear();
    this.rpc.close(error);
  }

  private async trySetSessionModel(sessionId: string, model: string): Promise<boolean> {
    try {
      await this.rpc.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: model,
      });
      return true;
    } catch {
      try {
        await this.rpc.request("session/set_model", { sessionId, modelId: model });
        return true;
      } catch {
        return false;
      }
    }
  }

  private pickPermissionOption(
    options: AcpPermissionOption[],
    allow: boolean,
  ): AcpPermissionOption | null {
    if (options.length === 0) return null;
    if (allow) {
      return (
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind?.startsWith("allow")) ??
        options[0]
      );
    }
    return (
      options.find((o) => o.kind === "reject_once") ??
      options.find((o) => o.kind?.startsWith("reject")) ??
      null
    );
  }

  private handleInboundNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const update = (p.update && typeof p.update === "object" ? p.update : null) as Record<
        string,
        unknown
      > | null;
      if (this.activeTurnId && update) {
        const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
        if (kind === "agent_message_chunk") {
          const content = update.content as { type?: unknown; text?: unknown } | undefined;
          const chunk =
            typeof content?.text === "string"
              ? content.text
              : typeof update.text === "string"
                ? update.text
                : "";
          if (chunk) this.turnChunkBuffer += chunk;
        } else if (kind === "tool_call" && this.turnChunkBuffer.trim()) {
          // Separate pre-tool narration from the post-tool final response.
          this.turnTextSegments.push(this.turnChunkBuffer);
          this.turnChunkBuffer = "";
        }
      }
      this.handlers.onNotification?.("acp/session_update", {
        ...p,
        turnId: this.activeTurnId,
      });
      return;
    }
    this.handlers.onNotification?.(method, params);
  }

  private handleInboundServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    if (method === "session/request_permission") {
      const rawOptions = Array.isArray(p.options) ? p.options : [];
      const options: AcpPermissionOption[] = rawOptions
        .filter((o): o is Record<string, unknown> => Boolean(o && typeof o === "object"))
        .map((o) => ({
          optionId: String(o.optionId ?? ""),
          ...(typeof o.name === "string" ? { name: o.name } : {}),
          ...(typeof o.kind === "string" ? { kind: o.kind } : {}),
        }))
        .filter((o) => o.optionId.length > 0);
      this.pendingPermissionOptions.set(String(id), options);
      this.handlers.onServerRequest?.(id, "acp/request_permission", {
        ...p,
        options,
        threadId: typeof p.sessionId === "string" ? p.sessionId : this.sessionId ?? undefined,
        turnId: this.activeTurnId ?? undefined,
      });
      return;
    }
    this.handlers.onServerRequest?.(id, method, params);
  }
}
