import { dirname } from "node:path";
import type { RuntimeAgent } from "@conflux/shared";
import { logger } from "../../log.js";
import type { DB } from "../db.js";
import { buildRuntimeEnv } from "../runtime-agents.js";
import { runtimeDescriptor } from "../runtime-registry.js";
import { cleanTerminalEnv } from "../terminal.js";
import { pinnedMcpLaunch } from "../wake/launcher.js";
import type {
  AdapterConnection,
  CanonicalApprovalKind,
  ManagedLaunchConfig,
  ManagedSessionContext,
  NormalizedNotification,
  RuntimeAdapter,
  ServerRequestClassification,
} from "../managed/adapter.js";
import { AcpStreamConnection, type AcpPermissionOption } from "./connection.js";

/**
 * Generic ACP (Agent Client Protocol) managed adapter + Antigravity (`agy acp`)
 * specialization. Normalizes ACP `session/update` notifications and
 * `session/request_permission` prompts onto Conflux's RuntimeAdapter contract.
 */

const TEXT_CAP = 2000;

function trimCap(value: unknown, cap = TEXT_CAP): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > cap ? `${value.slice(0, cap)}…` : value;
}

function buildAcpMcpServers(ctx?: ManagedSessionContext): Array<{
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}> {
  const db = ctx?.db as DB | undefined;
  if (!db?.name || db.name === ":memory:") return [];
  try {
    const dataDir = dirname(db.name);
    const launch = pinnedMcpLaunch(dataDir);
    const envPairs: Array<{ name: string; value: string }> = [
      { name: "CONFLUX_HOME", value: dataDir },
      ...(ctx?.instanceId ? [{ name: "CONFLUX_RUNTIME_INSTANCE_ID", value: ctx.instanceId }] : []),
      ...(ctx?.sessionId ? [{ name: "CONFLUX_SESSION_ID", value: ctx.sessionId }] : []),
      ...Object.entries(launch.env ?? {}).map(([name, value]) => ({ name, value })),
    ];
    return [
      {
        name: "conflux",
        command: launch.command,
        args: launch.args,
        env: envPairs,
      },
    ];
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "managed acp: failed to build pinned MCP server entry",
    );
    return [];
  }
}

function extractUpdateText(update: Record<string, unknown>): string | null {
  const content = update.content;
  if (typeof content === "string" && content.length > 0) return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as Record<string, unknown>;
    if (c.type === "text" && typeof c.text === "string" && c.text.length > 0) return c.text;
  }
  if (typeof update.text === "string" && update.text.length > 0) return update.text;
  return null;
}

export function defaultAcpLaunch(
  db: DB,
  agent: RuntimeAgent,
  defaultArgs: string[] = ["acp"],
): ManagedLaunchConfig {
  const def = runtimeDescriptor(agent.runtime);
  const env = buildRuntimeEnv(agent, cleanTerminalEnv());
  if (db.name && db.name !== ":memory:") env.CONFLUX_HOME = dirname(db.name);

  // Allow custom ACP command/args via extra_env (`ACP_COMMAND`, `ACP_ARGS`) for
  // generic `acp` presets (Copilot `--acp`, Cursor, Kiro, Gemini CLI, etc.).
  const executable = env.ACP_COMMAND || process.env[def.executableEnv] || def.executable;
  let args = [...defaultArgs];
  if (env.ACP_ARGS) {
    try {
      const parsed = JSON.parse(env.ACP_ARGS) as unknown;
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string")) {
        args = parsed;
      }
    } catch {
      args = env.ACP_ARGS.split(/\s+/).filter(Boolean);
    }
  }

  return {
    executable,
    args,
    env,
    cwd: agent.workdir || process.cwd(),
  };
}

export function createAcpAdapter(opts: {
  runtime: "antigravity" | "acp";
  label: string;
  defaultArgs?: string[];
}): RuntimeAdapter {
  const defaultArgs = opts.defaultArgs ?? ["acp"];

  return {
    runtime: opts.runtime,
    label: opts.label,

    defaultLaunch(db, agent) {
      return defaultAcpLaunch(db as DB, agent, defaultArgs);
    },

    createConnection(transport, handlers, options) {
      return new AcpStreamConnection(transport, handlers, options, opts.runtime);
    },

    async initialize(conn) {
      const info = (await conn.request("acp/initialize")) as {
        agentInfo?: { name?: string; version?: string };
      };
      logger.info(
        {
          runtime: opts.runtime,
          agentName: info?.agentInfo?.name ?? null,
          agentVersion: info?.agentInfo?.version ?? null,
        },
        "managed ACP session initialized",
      );
    },

    async startThread(conn, agent, cwd, ctx) {
      const started = (await conn.request("acp/session_new", {
        cwd,
        model: agent.model ?? undefined,
        systemPrompt: agent.instructions ?? undefined,
        mcpServers: buildAcpMcpServers(ctx),
      })) as { sessionId?: string };
      if (!started?.sessionId) throw new Error("ACP session/new returned no sessionId");
      return started.sessionId;
    },

    async resumeThread(conn, agent, threadId, ctx) {
      const resumed = (await conn.request("acp/session_load", {
        sessionId: threadId,
        cwd: agent.workdir || process.cwd(),
        mcpServers: buildAcpMcpServers(ctx),
      })) as { sessionId?: string };
      const resolvedId = resumed?.sessionId ?? threadId;
      if (resolvedId !== threadId) {
        throw new Error(`ACP session/load returned a different session: ${resolvedId}`);
      }
      return { threadId: resolvedId, turns: [] };
    },

    async startTurn(conn, threadId, input) {
      const started = (await conn.request("acp/turn_start", {
        sessionId: threadId,
        text: input.text,
        clientMessageId: input.clientMessageId,
      })) as { turnId?: string };
      if (!started?.turnId) throw new Error("ACP turn/start returned no turnId");
      return started.turnId;
    },

    async steerTurn(conn, threadId, turnId, input) {
      const res = (await conn.request("acp/turn_steer", {
        sessionId: threadId,
        turnId,
        text: input.text,
        clientMessageId: input.clientMessageId,
      })) as { accepted?: boolean; reason?: string };
      return { accepted: res?.accepted === true, reason: res?.reason };
    },

    async interrupt(conn, threadId, turnId) {
      await conn.request("acp/turn_cancel", { sessionId: threadId, turnId });
    },

    formatApprovalResponse(decision, extra) {
      return {
        decision,
        ...(extra?.optionId ? { optionId: extra.optionId } : {}),
      };
    },

    respond(conn: AdapterConnection, rpcId, result) {
      conn.respond(rpcId, result);
    },

    classifyServerRequest(method, params, ctx): ServerRequestClassification {
      if (method !== "acp/request_permission") {
        logger.warn({ method, runtime: opts.runtime }, "unhandled ACP server request declined");
        return { kind: "refuse", reason: `conflux does not handle ${method}` };
      }
      const p = (params ?? {}) as Record<string, unknown>;
      if (typeof p.threadId === "string" && p.threadId !== ctx.threadId) {
        return { kind: "refuse", reason: "session mismatch" };
      }
      if (!ctx.activeTurnId || (typeof p.turnId === "string" && p.turnId !== ctx.activeTurnId)) {
        return { kind: "refuse", reason: "no matching active turn" };
      }
      const toolCall = (p.toolCall && typeof p.toolCall === "object" ? p.toolCall : {}) as Record<
        string,
        unknown
      >;
      const options = Array.isArray(p.options) ? (p.options as AcpPermissionOption[]) : [];
      const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
      const title = trimCap(toolCall.title, 400);
      const allowCount = options.filter((o) => o.kind?.startsWith("allow")).length;
      // Multiple allow options represent an explicit single-choice question card.
      const approvalKind: CanonicalApprovalKind =
        allowCount > 1
          ? "userInput"
          : toolKind === "execute"
            ? "commandExecution"
            : toolKind === "edit" || toolKind === "delete"
              ? "fileChange"
              : "toolCall";
      return {
        kind: "approval",
        approvalKind,
        sanitized: {
          ...(title ? { title, toolName: title } : { toolName: toolKind || "ACP Tool" }),
          ...(toolKind ? { toolKind } : {}),
          ...(typeof toolCall.toolCallId === "string" ? { toolCallId: toolCall.toolCallId } : {}),
          ...(options.length > 0 ? { options } : {}),
        },
        turnId: typeof p.turnId === "string" ? p.turnId : ctx.activeTurnId,
      };
    },

    normalizeNotification(method, params): NormalizedNotification | null {
      const p = (params ?? {}) as Record<string, unknown>;
      const turnId = typeof p.turnId === "string" ? p.turnId : null;

      if (method === "acp/turn_completed") {
        const status = typeof p.status === "string" ? p.status : "completed";
        const errorMessage = typeof p.errorMessage === "string" ? p.errorMessage : null;
        const finalText = typeof p.finalText === "string" && p.finalText.trim() ? p.finalText.trim() : null;
        return {
          type: status === "failed" ? "error" : "status",
          payload: {
            status,
            ...(typeof p.stopReason === "string" ? { stopReason: p.stopReason } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          },
          turnId,
          agentText: finalText,
          turnCompleted: { turnId, status, errorMessage },
        };
      }

      if (method === "acp/session_update") {
        const update = (p.update && typeof p.update === "object" ? p.update : {}) as Record<
          string,
          unknown
        >;
        const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

        if (kind === "agent_message_chunk" || kind === "agent_message") {
          const text = extractUpdateText(update);
          if (!text) return null;
          return {
            type: "text",
            payload: { text, delta: kind === "agent_message_chunk" },
            turnId,
            // Streaming chunks are assembled by AcpConnection and delivered as a single
            // complete agentText on acp/turn_completed; full agent_message frames pass directly.
            agentText: kind === "agent_message" ? text : null,
            turnCompleted: null,
          };
        }

        if (kind === "tool_call" || kind === "tool_call_update") {
          return {
            type: "tool",
            payload: {
              phase: kind === "tool_call" ? "start" : String(update.status ?? "update"),
              ...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
              ...(typeof update.title === "string" ? { title: trimCap(update.title, 300) } : {}),
              ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
            },
            turnId,
            agentText: null,
            turnCompleted: null,
          };
        }

        if (kind === "plan") {
          return {
            type: "status",
            payload: {
              phase: "plan",
              entries: Array.isArray(update.entries) ? update.entries : [],
            },
            turnId,
            agentText: null,
            turnCompleted: null,
          };
        }
      }

      return null;
    },
  };
}

export const antigravityAdapter: RuntimeAdapter = createAcpAdapter({
  runtime: "antigravity",
  label: "Antigravity (agy)",
  defaultArgs: ["acp"],
});

export const acpAdapter: RuntimeAdapter = createAcpAdapter({
  runtime: "acp",
  label: "ACP Agent",
  defaultArgs: ["acp"],
});
