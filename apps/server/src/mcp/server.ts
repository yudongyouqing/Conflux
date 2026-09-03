import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { RuntimeId } from "@muiltchat/shared";

import { resolveConfig, type Scope } from "../config.js";
import { openDb, type DB } from "../core/db.js";
import {
  registerSession,
  listSessions,
  getSession,
} from "../core/sessions.js";
import {
  MCP_HEARTBEAT_INTERVAL_MS,
  claimMcpConnection,
  createMcpLeaseMetadata,
  installMcpStdioLifecycle,
  markMcpDisconnected,
  touchMcpConnection,
} from "../core/mcp-liveness.js";
import { getSetting } from "../core/app-settings.js";
import {
  publishContext,
  updateContext,
  deleteContext,
  listMyContext,
} from "../core/context.js";
import { queryContext } from "../core/search.js";
import {
  askSession,
  checkInbox,
  replyAsk,
  checkReplies,
  recordExchange,
} from "../core/messages.js";
import { getGraph } from "../core/graph.js";
import { mergeSessionMeta } from "../core/sessions.js";
import { logAudit } from "../core/audit.js";
import {
  getRuntimePid,
  findSessionByRuntimePid,
  deleteUnreferencedSession,
} from "../core/live.js";
import { wakeOfflineSession } from "../core/runtime-agents.js";
import { logger } from "../log.js";

const INSTRUCTIONS = `
muiltchat: cross-session context + async messaging for AI coding assistants.

This session is already auto-registered. Call register_session to update its
name and description with something meaningful for other sessions to recognize.

You share a SQLite file with other sessions, so you can:
  - publish_context: expose a slice of your context for other sessions to search
  - query_context: FTS-search what other sessions have published
  - ask_session / reply_ask / check_inbox / check_replies: async Q&A between sessions
  - get_graph: see the session topology (who's online, who talked to whom)

For messaging Claude Code peers you may prefer your NATIVE SendMessage tool
(lower latency). When you do, call log_exchange once afterwards so the
exchange lands in the shared archive + graph. muiltchat ask_session stays
the channel for non-claude runtimes and offline mail.

After answering a user, if you discovered something worth sharing, proactively
publish_context. Before answering a question that might already be answered
elsewhere, query_context first.

All operations are audited. Be concise in published content; prefer structured
tags for discoverability.
`.trim();

export interface McpServerOptions {
  scope?: Scope;
  overrideDataDir?: string;
}

function detectMcpRuntime(): { runtime: RuntimeId; pid: number | null } {
  const configured = process.env.MUILTCHAT_AGENT_RUNTIME;
  if (configured === "claude" || configured === "codex") {
    return { runtime: configured, pid: getRuntimePid(configured) };
  }
  const codexPid = getRuntimePid("codex");
  if (codexPid !== null) return { runtime: "codex", pid: codexPid };
  return { runtime: "claude", pid: getRuntimePid("claude") };
}

export function buildMcpSessionMetadata(input: {
  connectionId: string;
  runtime: RuntimeId;
  pid: number | null;
  agentTag?: Record<string, unknown>;
  now?: Date;
}): Record<string, unknown> {
  return {
    temp: true,
    ...input.agentTag,
    runtime: input.runtime,
    ...(input.pid !== null ? { runtime_pid: input.pid } : {}),
    ...createMcpLeaseMetadata(input.connectionId, input.now),
  };
}

export function adoptMcpSession(
  currentSessionId: string,
  targetSessionId: string,
  claim: () => boolean,
  deletePrevious: (id: string) => void
): { sessionId: string; adopted: boolean } {
  if (currentSessionId === targetSessionId || !claim()) {
    return { sessionId: currentSessionId, adopted: false };
  }
  deletePrevious(currentSessionId);
  return { sessionId: targetSessionId, adopted: true };
}

export async function runMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const config = resolveConfig(opts.scope ?? "global", opts.overrideDataDir);
  const db: DB = openDb(config);
  const connectionId = uuidv4();
  let sessionId = uuidv4();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let identity = detectMcpRuntime();

  // Auto-register immediately so the session is visible in the graph
  // and available for cross-session communication without waiting for
  // the LLM to call register_session. metadata.temp marks this as a
  // placeholder node — the graph hides unadopted temps to cut noise.
  // A session spawned from a runtime-agent preset carries the preset id in
  // its env (set by startRuntimeAgent) — stamp it into metadata.
  const dirName = projectDir.replace(/\\/g, "/").split("/").pop() || "session";
  const agentTag = (() => {
    const aid = process.env.MUILTCHAT_AGENT_ID;
    if (!aid || Number.isNaN(Number(aid))) return {};
    return {
      agent_id: Number(aid),
      ...(process.env.MUILTCHAT_AGENT_RUNTIME
        ? { runtime: process.env.MUILTCHAT_AGENT_RUNTIME }
        : {}),
    };
  })();
  registerSession(db, {
    id: sessionId,
    name: dirName,
    description: `${identity.runtime === "codex" ? "Codex" : "Claude Code"} session (auto-registered)`,
    project_dir: projectDir,
    identity_source: "mcp",
    metadata: buildMcpSessionMetadata({
      connectionId,
      runtime: identity.runtime,
      pid: identity.pid,
      agentTag,
    }),
  });

  logger.info(
    { sessionId, runtime: identity.runtime, runtimePid: identity.pid, dataDir: config.dataDir, scope: config.scope },
    "mcp starting"
  );

  // If the CLI integration registered a session for this same runtime
  // process (matched by pid), adopt it: our tools then act as that
  // conversation-id-keyed session, and the temp uuid node is removed.
  // Best-effort — without hooks installed we keep the temp node.
  //
  // Re-resolved on every beat AND every tool call (no one-shot latch): a
  // /resume mid-process moves the conversation to a new id, and the hook
  // pins the authoritative current id under claude-current:<pid> — read
  // that first; heartbeat-order guessing is only the fallback (it lags and
  // can flap between the old and new rows).
  let beat: NodeJS.Timeout | undefined;
  let disposeStdio: (() => void) | undefined;
  let disconnected = false;

  const disconnect = (reason: string): void => {
    if (disconnected) return;
    disconnected = true;
    if (beat) clearInterval(beat);
    disposeStdio?.();
    try {
      markMcpDisconnected(db, sessionId, connectionId, reason);
    } catch {
      // transient sqlite lock contention must not prevent database cleanup
    }
    try {
      if (db.open) db.close();
    } catch {
      // the database may already be closed by an outer shutdown path
    }
  };

  const tryAdopt = () => {
    // Explicit identity first: a headless auto-answer wake tells us which
    // conversation it is answering FOR (newer claude versions don't fire
    // registering hooks in -p mode, so pid/pin adoption may find nothing).
    if (identity.pid === null) identity = detectMcpRuntime();
    const assume = process.env.MUILTCHAT_ASSUME_SESSION;
    const pid = getRuntimePid(identity.runtime);
    const pinned = pid === null ? null : getSetting(db, `${identity.runtime}-current:${pid}`);
    if (pid !== null) {
      mergeSessionMeta(db, sessionId, { runtime: identity.runtime, runtime_pid: pid });
    }
    const target =
      (assume ? getSession(db, assume) : null) ??
      (pinned ? getSession(db, pinned) : null) ??
      (pid === null ? null : findSessionByRuntimePid(db, identity.runtime, pid, sessionId));
    if (!target) return; // hook hasn't fired yet — retry on the next tick
    if (target.id === sessionId) return;
    const oldId = sessionId;
    const adoption = adoptMcpSession(
      oldId,
      target.id,
      () => {
        try {
          return claimMcpConnection(db, target.id, connectionId);
        } catch {
          // transient sqlite lock contention — retry adoption later
          return false;
        }
      },
      (previousId) => deleteUnreferencedSession(db, previousId)
    );
    if (!adoption.adopted) return;
    sessionId = adoption.sessionId;
    logger.info({ runtime: identity.runtime, runtimePid: pid, sessionId, oldId }, "mcp adopted hook-registered session");
  };

  const touchLease = (): void => {
    try {
      touchMcpConnection(db, sessionId, connectionId);
    } catch {
      // transient sqlite lock contention — next tick or tool call retries
    }
  };

  tryAdopt();

  // Keep this session marked active for as long as the MCP process lives,
  // even when no tool calls happen. Process exit stops the lease and it
  // expires after MCP_LEASE_TTL_MS.
  beat = setInterval(() => {
    try {
      tryAdopt();
      touchLease();
    } catch {
      // transient sqlite lock contention — next tick retries
    }
  }, MCP_HEARTBEAT_INTERVAL_MS);
  beat.unref();

  const server = new McpServer(
    {
      name: "muiltchat",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  );

  /** Wrapper that auto-adopts + touches the lease + audits + standardises errors. */
  async function withAudit<T>(
    action: string,
    args: Record<string, unknown>,
    fn: () => T | Promise<T>
  ): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
    tryAdopt(); // pick up /resume id changes instantly, not on the next 30s beat
    touchLease();
    try {
      const result = await fn();
      logAudit(db, {
        caller_session: sessionId,
        interface: "mcp",
        action,
        args,
        result: safeSummary(result),
      });
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAudit(db, {
        caller_session: sessionId,
        interface: "mcp",
        action,
        args,
        result: { error: message },
      });
      return { ok: false, error: message };
    }
  }

  // 1. register_session
  server.registerTool(
    "register_session",
    {
      description:
        "Register (or refresh) the current session's identity. Call once at the start of a conversation.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Human-readable session name"),
        description: z
          .string()
          .max(2000)
          .optional()
          .describe("Short description of this session's purpose"),
        skills: z
          .array(z.string().min(1).max(60))
          .max(20)
          .optional()
          .describe(
            "Agent Card: what this session is good at (e.g. ['typescript','sql']) — shown on the graph so peers can route questions"
          ),
      },
    },
    async ({ name, description, skills }) => {
      const r = await withAudit(
        "register_session",
        { name, description, skills },
        () => {
          const session = registerSession(db, {
            id: sessionId,
            name,
            description: description ?? null,
            project_dir: projectDir,
          });
          // Merge (not replace) so hook metadata (claude_pid, named, …) survives.
          if (skills && skills.length > 0) {
            mergeSessionMeta(db, sessionId, { agent_card: { skills } });
          }
          return session;
        }
      );
      return json(r.ok ? { session_id: sessionId, session: r.result } : { error: r.error });
    }
  );

  // 2. list_sessions
  server.registerTool(
    "list_sessions",
    {
      description:
        "List registered sessions with context counts and pending inbox counts. Use status='active' to find live peers.",
      inputSchema: {
        status: z
          .enum(["active", "stale", "ended", "all"])
          .optional()
          .describe("Filter by status; default 'active'"),
      },
    },
    async ({ status }) => {
      const r = await withAudit("list_sessions", { status }, () =>
        listSessions(db, { status: status ?? "active" })
      );
      return json(r.ok ? { sessions: r.result } : { error: r.error });
    }
  );

  // 3. publish_context
  server.registerTool(
    "publish_context",
    {
      description:
        "Publish a piece of your session's context (a finding, a decision, a snippet) so other sessions can search it.",
      inputSchema: {
        title: z.string().min(1).max(300).describe("Short title"),
        content: z.string().min(1).max(50_000).describe("The context body"),
        tags: z
          .array(z.string().min(1).max(60))
          .max(20)
          .optional()
          .describe("Optional tags for filtering"),
      },
    },
    async ({ title, content, tags }) => {
      const r = await withAudit(
        "publish_context",
        { title, tags, contentLen: content.length },
        () => publishContext(db, { session_id: sessionId, title, content, tags: tags ?? null })
      );
      return json(r.ok ? { entry: r.result } : { error: r.error });
    }
  );

  // 4. update_context
  server.registerTool(
    "update_context",
    {
      description: "Update one of your previously published context entries.",
      inputSchema: {
        entry_id: z.number().int().positive(),
        title: z.string().min(1).max(300).optional(),
        content: z.string().min(1).max(50_000).optional(),
        tags: z.array(z.string().min(1).max(60)).max(20).optional(),
      },
    },
    async ({ entry_id, title, content, tags }) => {
      const r = await withAudit("update_context", { entry_id, title, tags, contentLen: content?.length }, () =>
        updateContext(db, entry_id, sessionId, { title, content, tags })
      );
      return json(r.ok ? { entry: r.result } : { error: r.error });
    }
  );

  // 5. delete_context
  server.registerTool(
    "delete_context",
    {
      description: "Delete one of your previously published context entries.",
      inputSchema: {
        entry_id: z.number().int().positive(),
      },
    },
    async ({ entry_id }) => {
      const r = await withAudit("delete_context", { entry_id }, () =>
        deleteContext(db, entry_id, sessionId)
      );
      return json(r.ok ? { deleted: r.result } : { error: r.error });
    }
  );

  // 6. list_my_context
  server.registerTool(
    "list_my_context",
    {
      description: "List the context entries your session has published.",
      inputSchema: {},
    },
    async () => {
      const r = await withAudit("list_my_context", {}, () => listMyContext(db, sessionId));
      return json(r.ok ? { entries: r.result } : { error: r.error });
    }
  );

  // 7. query_context
  server.registerTool(
    "query_context",
    {
      description:
        "Full-text search across all sessions' published context (or a specific session). Empty query returns most recent entries.",
      inputSchema: {
        query: z.string().max(2000).optional().describe("FTS query string"),
        session_id: z
          .string()
          .optional()
          .describe("Restrict to a specific session"),
        tags: z.array(z.string().min(1).max(60)).max(20).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ query, session_id, tags, limit }) => {
      const r = await withAudit(
        "query_context",
        { query, session_id, tags, limit },
        () => queryContext(db, { query, session_id, tags, limit })
      );
      return json(r.ok ? { entries: r.result } : { error: r.error });
    }
  );

  // 8. ask_session
  server.registerTool(
    "ask_session",
    {
      description:
        "Ask another session a question. The target session will see it in check_inbox and may reply asynchronously.",
      inputSchema: {
        to_session: z.string().min(1).describe("Target session id"),
        question: z.string().min(1).max(20_000).describe("The question"),
      },
    },
    async ({ to_session, question }) => {
      const r = await withAudit(
        "ask_session",
        { to_session, questionLen: question.length },
        () => askSession(db, { from_session: sessionId, to_session, question })
      );
      // true auto-answer: offline addressees get headlessly woken to reply
      let wake: { woke: boolean; reason?: string } = { woke: false, reason: "ask failed" };
      if (r.ok) {
        try {
          wake = wakeOfflineSession(db, to_session);
        } catch {
          // best-effort
        }
      }
      return json(r.ok ? { message: r.result, wake } : { error: r.error });
    }
  );

  // 9. check_inbox
  server.registerTool(
    "check_inbox",
    {
      description:
        "Check unanswered questions other sessions have asked you. Reading marks them seen (askers can tell you looked); reply with reply_ask.",
      inputSchema: {},
    },
    async () => {
      const r = await withAudit("check_inbox", {}, () => checkInbox(db, sessionId));
      return json(r.ok ? { inbox: r.result } : { error: r.error });
    }
  );

  // 10. reply_ask
  server.registerTool(
    "reply_ask",
    {
      description: "Reply to a question addressed to your session.",
      inputSchema: {
        message_id: z.number().int().positive(),
        reply: z.string().min(1).max(20_000),
      },
    },
    async ({ message_id, reply }) => {
      const r = await withAudit(
        "reply_ask",
        { message_id, replyLen: reply.length },
        () => replyAsk(db, message_id, sessionId, reply)
      );
      return json(r.ok ? { message: r.result } : { error: r.error });
    }
  );

  // 11. check_replies
  server.registerTool(
    "check_replies",
    {
      description:
        "Check replies to questions your session has asked. Marks them read.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("ISO timestamp; only replies after this"),
      },
    },
    async ({ since }) => {
      const r = await withAudit("check_replies", { since }, () =>
        checkReplies(db, sessionId, since)
      );
      return json(r.ok ? { replies: r.result } : { error: r.error });
    }
  );

  // 12. log_exchange — archive a native-channel exchange (see INSTRUCTIONS)
  server.registerTool(
    "log_exchange",
    {
      description:
        "Archive a message exchange that already happened OUTSIDE muiltchat (e.g. via Claude Code's native SendMessage) into the shared history + graph, so other sessions can discover it. Call after the native exchange completes; do not use for muiltchat-delivered mail.",
      inputSchema: {
        to_session: z.string().min(1).describe("Peer the exchange was with"),
        question: z.string().min(1).max(20_000).describe("What was asked/sent"),
        reply: z
          .string()
          .max(20_000)
          .optional()
          .describe("Their answer, if already received"),
        occurred_at: z
          .string()
          .optional()
          .describe("ISO timestamp of the exchange; default now"),
      },
    },
    async ({ to_session, question, reply, occurred_at }) => {
      const r = await withAudit(
        "log_exchange",
        { to_session, questionLen: question.length },
        () =>
          recordExchange(db, {
            from_session: sessionId,
            to_session,
            question,
            reply: reply ?? null,
            occurred_at,
          })
      );
      return json(r.ok ? { message: r.result } : { error: r.error });
    }
  );

  // 13. get_graph
  server.registerTool(
    "get_graph",
    {
      description:
        "Get the session communication graph: nodes (sessions) and directed edges (who talked to whom, with weights). Useful for discovering peers and understanding interaction patterns.",
      inputSchema: {
        status: z
          .enum(["active", "stale", "ended", "all"])
          .optional()
          .describe("Filter nodes by status; default 'active'"),
      },
    },
    async ({ status }) => {
      const r = await withAudit("get_graph", { status }, () =>
        getGraph(db, { status: status ?? "active" })
      );
      return json(r.ok ? { graph: r.result } : { error: r.error });
    }
  );

  const transport = new StdioServerTransport();
  disposeStdio = installMcpStdioLifecycle(process.stdin, transport, disconnect);
  try {
    await server.connect(transport);
  } catch (err) {
    disconnect("connect-failed");
    throw err;
  }
  logger.info({ sessionId }, "mcp connected via stdio");

  // Abrupt process termination still relies on the MCP lease TTL.
}

function json(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function safeSummary(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    // Strip large `content` fields from context entries to keep audit small.
    const v = value as Record<string, unknown>;
    if (Array.isArray(v)) return { count: v.length };
    if (typeof v.content === "string") {
      const { content: _c, ...rest } = v;
      return { ...rest, contentLen: v.content.length };
    }
    return rest(v);
  }
  return { value: String(value).slice(0, 200) };
}

function rest(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.length > 200) out[k] = `<${val.length} chars>`;
    else out[k] = val;
  }
  return out;
}
