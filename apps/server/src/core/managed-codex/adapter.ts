import type { DB } from "../db.js";
import { dirname } from "node:path";
import { logger } from "../../log.js";
import type { RuntimeAgent } from "@conflux/shared";
import { cleanTerminalEnv } from "../terminal.js";
import { buildCodexManagedMcpArgs, buildRuntimeEnv } from "../runtime-agents.js";
import { runtimeDescriptor } from "../runtime-registry.js";
import { getTerminalSettings } from "../app-settings.js";
import type {
  AdapterConnection,
  ManagedLaunchConfig,
  NormalizedHistoryTurn,
  NormalizedNotification,
  RuntimeAdapter,
  ServerRequestClassification,
} from "../managed/adapter.js";
import { assertSupportedCodexVersion } from "./version.js";
import { normalizeNotification as normalizeCodexNotification, mergeFinalText } from "./events.js";
import { sanitizeApprovalPayload, type ApprovalKind } from "./approvals.js";

/**
 * The Codex app-server adapter: every wire-shape decision for the managed
 * executor lives here — method names, parameter fields (including the
 * developerInstructions slot), the handshake version gate, notification
 * normalization, approval classification and thread-history parsing. The
 * runtime-agnostic scheduling/state machine lives in core/managed/executor.
 */

const CLIENT_INFO = {
  clientInfo: { name: "conflux", title: "Conflux managed executor", version: "0.3.1" },
  capabilities: null,
};

/** Trimmed preset instructions, or null when the preset carries none. */
function developerInstructions(agent: RuntimeAgent): string | null {
  return agent.instructions?.trim() ? agent.instructions.trim() : null;
}

/** Resolve the default codex app-server launch from settings/env. */
export function defaultCodexLaunch(db: DB, agent: RuntimeAgent): ManagedLaunchConfig {
  const settings = getTerminalSettings(db);
  const def = runtimeDescriptor(agent.runtime);
  const defaultExe = def.settingsKey ? settings[def.settingsKey] : def.executable;
  const executable = process.env[def.executableEnv] || defaultExe;
  const env = buildRuntimeEnv(agent, cleanTerminalEnv());
  const args = ["app-server"];
  if (db.name && db.name !== ":memory:") {
    env.CONFLUX_HOME = dirname(db.name);
    args.push(...buildCodexManagedMcpArgs(env, db));
  }
  return {
    executable,
    args,
    env,
    cwd: agent.workdir || process.cwd(),
  };
}

export const codexAdapter: RuntimeAdapter = {
  runtime: "codex",
  label: "Codex",

  defaultLaunch(db, agent) {
    return defaultCodexLaunch(db as DB, agent);
  },

  async initialize(conn) {
    const init = (await conn.request("initialize", CLIENT_INFO)) as { userAgent?: string };
    // The wire protocol is certified against one codex minor — a drifted
    // app-server fails fast here instead of corrupting a thread midway.
    assertSupportedCodexVersion(init?.userAgent);
    logger.info({ userAgent: init?.userAgent }, "managed codex app-server initialized");
  },

  async startThread(conn, agent, cwd) {
    // Preset instructions ride the protocol's developer-instructions slot
    // (the analog of claude's --append-system-prompt); terminal codex has
    // no CLI flag for this, managed mode must not lose it.
    const instructions = developerInstructions(agent);
    const started = (await conn.request("thread/start", {
      cwd,
      ...(agent.model ? { model: agent.model } : {}),
      ...(instructions ? { developerInstructions: instructions } : {}),
    })) as { thread?: { id?: string } };
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    return threadId;
  },

  async resumeThread(conn, agent, threadId) {
    // Re-attach the CURRENT preset instructions, like the terminal
    // launcher re-appends them on every resume: editing the preset between
    // crash and recovery takes effect on the resumed thread.
    const instructions = developerInstructions(agent);
    const resumed = (await conn.request("thread/resume", {
      threadId,
      ...(instructions ? { developerInstructions: instructions } : {}),
    })) as {
      thread?: {
        id?: string;
        turns?: Array<{
          id: string;
          status: string;
          error?: { message?: string } | null;
          items?: Array<{ type?: string; text?: string }>;
        }>;
      };
    };
    if (resumed?.thread?.id && resumed.thread.id !== threadId) {
      throw new Error(`thread/resume returned a different thread: ${resumed.thread.id}`);
    }
    const turns: NormalizedHistoryTurn[] = (resumed?.thread?.turns ?? []).map((t) => ({
      turnId: t.id,
      status: t.status,
      errorMessage: t.error?.message ?? null,
      finalText: mergeFinalText(
        (t.items ?? [])
          .filter((i) => i.type === "agentMessage" && typeof i.text === "string")
          .map((i) => i.text as string),
      ),
    }));
    return { threadId: resumed?.thread?.id ?? threadId, turns };
  },

  async startTurn(conn, threadId, input) {
    const turn = (await conn.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      clientUserMessageId: input.clientMessageId,
    })) as { turn?: { id?: string } };
    const turnId = turn?.turn?.id;
    if (!turnId) throw new Error("turn/start returned no turn id");
    return turnId;
  },

  async steerTurn(conn, threadId, turnId, input) {
    try {
      await conn.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
        ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
      });
      return { accepted: true };
    } catch (err) {
      return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  async interrupt(conn, threadId, turnId) {
    await conn.request("turn/interrupt", { threadId, turnId });
  },

  respond(conn: AdapterConnection, rpcId, result) {
    conn.respond(rpcId, result);
  },

  classifyServerRequest(method, params, ctx): ServerRequestClassification {
    const kind: ApprovalKind | null =
      method === "item/commandExecution/requestApproval"
        ? "commandExecution"
        : method === "item/fileChange/requestApproval"
          ? "fileChange"
          : method === "item/userInput/request" || method === "requestUserInput"
            ? "userInput"
            : null;
    if (!kind) {
      logger.warn({ method }, "unhandled app-server request declined");
      return { kind: "refuse", reason: `conflux does not handle ${method}` };
    }
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p.threadId === "string" && p.threadId !== ctx.threadId) {
      return { kind: "refuse", reason: "thread mismatch" };
    }
    if (!ctx.activeTurnId || (typeof p.turnId === "string" && p.turnId !== ctx.activeTurnId)) {
      return { kind: "refuse", reason: "no matching active turn" };
    }
    return {
      kind: "approval",
      approvalKind: kind,
      sanitized: sanitizeApprovalPayload(kind, p),
      turnId: typeof p.turnId === "string" ? p.turnId : null,
    };
  },

  normalizeNotification(method, params): NormalizedNotification | null {
    const normalized = normalizeCodexNotification(method, params);
    if (!normalized) return null;
    const ids = (params ?? {}) as { threadId?: string; turnId?: string; item?: unknown; turn?: unknown };
    let agentText: string | null = null;
    if (
      method === "item/completed" &&
      typeof ids.item === "object" &&
      ids.item !== null &&
      (ids.item as { type?: string }).type === "agentMessage" &&
      typeof (ids.item as { text?: unknown }).text === "string"
    ) {
      agentText = (ids.item as { text: string }).text;
    }
    let turnCompleted: NormalizedNotification["turnCompleted"] = null;
    if (method === "turn/completed") {
      const turn = (params as { turn?: { id?: string; status?: string; error?: { message?: string } | null } })
        .turn;
      turnCompleted = {
        turnId: turn?.id ?? null,
        status: turn?.status ?? "",
        errorMessage: turn?.error?.message ?? null,
      };
    }
    const nestedTurnId =
      typeof ids.turn === "object" && ids.turn !== null && typeof (ids.turn as { id?: unknown }).id === "string"
        ? (ids.turn as { id: string }).id
        : null;
    return {
      type: normalized.type,
      payload: normalized.payload,
      turnId: typeof ids.turnId === "string" ? ids.turnId : nestedTurnId,
      agentText,
      turnCompleted,
    };
  },
};
