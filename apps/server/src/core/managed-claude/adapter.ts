import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeAgent } from "@conflux/shared";
import { logger } from "../../log.js";
import type { DB } from "../db.js";
import { getTerminalSettings } from "../app-settings.js";
import { buildRuntimeEnv } from "../runtime-agents.js";
import { runtimeDescriptor } from "../runtime-registry.js";
import { cleanTerminalEnv } from "../terminal.js";
import type {
  AdapterConnection,
  CanonicalApprovalKind,
  ManagedLaunchConfig,
  ManagedLaunchOptions,
  NormalizedHistoryTurn,
  NormalizedNotification,
  RuntimeAdapter,
  ServerRequestClassification,
} from "../managed/adapter.js";
import { ClaudeStreamConnection } from "./stream-connection.js";

/**
 * The Claude Code managed adapter: translates Claude Code's native NDJSON
 * stream-json + SDK control protocol into the runtime-agnostic RuntimeAdapter
 * contract driven by core/managed/executor.ts.
 */

const COMMAND_TOOLS = new Set(["Bash", "Shell", "Terminal", "KillShell", "bash", "shell"]);
const TEXT_CAP = 2000;

function trimCap(value: unknown, cap = TEXT_CAP): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > cap ? `${value.slice(0, cap)}…` : value;
}

function sanitizeClaudeApproval(
  kind: CanonicalApprovalKind,
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "commandExecution") {
    return {
      toolName,
      ...(trimCap(input.command) ? { command: trimCap(input.command) } : {}),
      ...(trimCap(input.description, 400) ? { description: trimCap(input.description, 400) } : {}),
      ...(trimCap(input.cwd, 500) ? { cwd: trimCap(input.cwd, 500) } : {}),
    };
  }
  const filePath =
    trimCap(input.file_path, 500) ??
    trimCap(input.path, 500) ??
    trimCap(input.notebook_path, 500);
  return {
    toolName,
    ...(filePath ? { filePath } : {}),
    ...(trimCap(input.description, 400) ? { description: trimCap(input.description, 400) } : {}),
  };
}

/** Encode a project cwd into Claude Code's ~/.claude/projects/<dir> folder name. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** Read Claude Code's local JSONL transcript for best-effort crash reconciliation. */
export function readClaudeTranscriptTurns(
  sessionId: string,
  cwd: string,
  claudeHome: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): NormalizedHistoryTurn[] {
  const transcriptPath = join(
    claudeHome,
    "projects",
    encodeClaudeProjectDir(cwd),
    `${sessionId}.jsonl`,
  );
  if (!existsSync(transcriptPath)) return [];
  try {
    const lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    const turns: NormalizedHistoryTurn[] = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        const entry = JSON.parse(raw) as Record<string, unknown>;
        if (entry.type === "result" && typeof entry.result === "string") {
          turns.push({
            turnId: typeof entry.uuid === "string" ? entry.uuid : `transcript-${turns.length + 1}`,
            status: entry.is_error ? "failed" : "completed",
            errorMessage: entry.is_error ? String(entry.result) : null,
            finalText: entry.is_error ? null : entry.result,
          });
        }
      } catch {
        // skip malformed transcript lines
      }
    }
    return turns;
  } catch {
    return [];
  }
}

export function defaultClaudeLaunch(
  db: DB,
  agent: RuntimeAgent,
  opts?: ManagedLaunchOptions,
): ManagedLaunchConfig {
  const settings = getTerminalSettings(db);
  const def = runtimeDescriptor("claude");
  const defaultExe = def.settingsKey ? settings[def.settingsKey] : def.executable;
  const executable = process.env[def.executableEnv] || defaultExe;
  const env = buildRuntimeEnv(agent, cleanTerminalEnv());
  if (db.name && db.name !== ":memory:") env.CONFLUX_HOME = dirname(db.name);

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompts",
    "host",
  ];
  if (opts?.resumeThreadId) {
    args.push("--resume", opts.resumeThreadId);
  } else {
    args.push("--session-id", randomUUID());
  }
  if (agent.model?.trim()) {
    args.push("--model", agent.model.trim());
  }
  if (agent.instructions?.trim()) {
    args.push("--append-system-prompt", agent.instructions.trim());
  }

  return {
    executable,
    args,
    env,
    cwd: agent.workdir || process.cwd(),
  };
}

export const claudeAdapter: RuntimeAdapter = {
  runtime: "claude",
  label: "Claude Code",

  defaultLaunch(db, agent, opts) {
    return defaultClaudeLaunch(db as DB, agent, opts);
  },

  createConnection(transport, handlers, options) {
    return new ClaudeStreamConnection(transport, handlers, options);
  },

  async initialize(conn) {
    const init = (await conn.request("initialize")) as { pid?: number; session_id?: string | null };
    logger.info(
      { pid: init?.pid ?? null, sessionId: init?.session_id ?? null },
      "managed claude stream-json session initialized",
    );
  },

  async startThread(conn) {
    const started = (await conn.request("session/start")) as { session_id?: string };
    const threadId = started?.session_id;
    if (!threadId) throw new Error("claude session/start returned no session id");
    return threadId;
  },

  async resumeThread(conn, agent, threadId) {
    const resumed = (await conn.request("session/resume", { threadId })) as {
      session_id?: string;
      turns?: NormalizedHistoryTurn[];
    };
    const resolvedId = resumed?.session_id ?? threadId;
    if (resolvedId !== threadId) {
      throw new Error(`claude session/resume returned a different session: ${resolvedId}`);
    }
    const turns =
      Array.isArray(resumed?.turns) && resumed.turns.length > 0
        ? resumed.turns
        : readClaudeTranscriptTurns(resolvedId, agent.workdir || process.cwd());
    return { threadId: resolvedId, turns };
  },

  async startTurn(conn, threadId, input) {
    const started = (await conn.request("turn/start", {
      threadId,
      text: input.text,
      clientMessageId: input.clientMessageId,
    })) as { turnId?: string };
    const turnId = started?.turnId;
    if (!turnId) throw new Error("claude turn/start returned no turn id");
    return turnId;
  },

  async interrupt(conn, threadId, turnId) {
    await conn.request("turn/interrupt", { threadId, turnId });
  },

  respond(conn: AdapterConnection, rpcId, result) {
    conn.respond(rpcId, result);
  },

  classifyServerRequest(method, params, ctx): ServerRequestClassification {
    if (method !== "claude/can_use_tool") {
      logger.warn({ method }, "unhandled claude control request declined");
      return { kind: "refuse", reason: `conflux does not handle ${method}` };
    }
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p.threadId === "string" && p.threadId !== ctx.threadId) {
      return { kind: "refuse", reason: "session mismatch" };
    }
    if (!ctx.activeTurnId || (typeof p.turnId === "string" && p.turnId !== ctx.activeTurnId)) {
      return { kind: "refuse", reason: "no matching active turn" };
    }
    const toolName = typeof p.tool_name === "string" && p.tool_name ? p.tool_name : "Tool";
    const rawInput =
      p.input && typeof p.input === "object" && !Array.isArray(p.input)
        ? (p.input as Record<string, unknown>)
        : {};
    const approvalKind: CanonicalApprovalKind = COMMAND_TOOLS.has(toolName)
      ? "commandExecution"
      : "fileChange";
    return {
      kind: "approval",
      approvalKind,
      sanitized: sanitizeClaudeApproval(approvalKind, toolName, rawInput),
      turnId: typeof p.turnId === "string" ? p.turnId : ctx.activeTurnId,
    };
  },

  normalizeNotification(method, params): NormalizedNotification | null {
    const p = (params ?? {}) as Record<string, unknown>;
    const turnId = typeof p.turnId === "string" ? p.turnId : null;

    if (method === "claude/assistant") {
      const message = p.message as { content?: Array<Record<string, unknown>> } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const texts: string[] = [];
      const tools: Array<{ name: string; id?: string }> = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          texts.push(b.text);
        } else if (b?.type === "tool_use" && typeof b.name === "string") {
          tools.push({
            name: b.name,
            ...(typeof b.id === "string" ? { id: b.id } : {}),
          });
        }
      }
      if (texts.length > 0) {
        const merged = texts.join("\n");
        return {
          type: "text",
          payload: { text: merged },
          turnId,
          agentText: merged,
          turnCompleted: null,
        };
      }
      if (tools.length > 0) {
        return {
          type: "tool",
          payload: { phase: "start", tools },
          turnId,
          agentText: null,
          turnCompleted: null,
        };
      }
      return null;
    }

    if (method === "claude/user") {
      const message = p.message as { content?: Array<Record<string, unknown>> } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const hasToolResult = blocks.some((b) => b?.type === "tool_result");
      if (!hasToolResult) return null;
      return {
        type: "tool",
        payload: { phase: "result", count: blocks.filter((b) => b?.type === "tool_result").length },
        turnId,
        agentText: null,
        turnCompleted: null,
      };
    }

    if (method === "claude/result") {
      const subtype = typeof p.subtype === "string" ? p.subtype : "";
      const isError = p.is_error === true || subtype.startsWith("error");
      const interrupted = p.interrupted === true || subtype === "interrupted";
      const status = interrupted ? "interrupted" : isError ? "failed" : "completed";
      const resultText = typeof p.result === "string" && p.result.trim() ? p.result : null;
      const errorMessage = isError
        ? resultText ?? (typeof p.error === "string" ? p.error : subtype || "claude turn failed")
        : null;
      return {
        type: status === "failed" ? "error" : "status",
        payload: {
          status,
          ...(resultText ? { result: trimCap(resultText, 500) } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
        },
        turnId,
        agentText: !isError && !interrupted ? resultText : null,
        turnCompleted: {
          turnId,
          status,
          errorMessage,
        },
      };
    }

    return null;
  },
};
