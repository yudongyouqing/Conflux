import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

import { resolveConfig, type Scope } from "../config.js";
import { openDb, type DB } from "../core/db.js";
import {
  registerSession,
  listSessions,
  heartbeat,
} from "../core/sessions.js";
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
} from "../core/messages.js";
import { getGraph } from "../core/graph.js";
import { logAudit } from "../core/audit.js";
import { logger } from "../log.js";

const INSTRUCTIONS = `
muiltchat: cross-session context + async messaging for AI coding assistants.

Each Claude Code session spawns its own MCP process with its own session_id.
Sessions share a SQLite file, so you can:
  - publish_context: expose a slice of your context for other sessions to search
  - query_context: FTS-search what other sessions have published
  - ask_session / reply_ask / check_inbox / check_replies: async Q&A between sessions

First call in any conversation should be register_session({name, description?}).
Then call heartbeat implicitly via other tool calls.

After answering a user, if you discovered something the user will likely ask
other sessions about, proactively publish_context. Before answering a user
question that might already be answered elsewhere, query_context first.

All operations are audited. Be concise in published content; prefer structured
tags for discoverability.
`.trim();

export interface McpServerOptions {
  scope?: Scope;
  overrideDataDir?: string;
}

export async function runMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const config = resolveConfig(opts.scope ?? "global", opts.overrideDataDir);
  const db: DB = openDb(config);
  const sessionId = uuidv4();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  logger.info({ sessionId, dataDir: config.dataDir, scope: config.scope }, "mcp starting");

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

  /** Wrapper that auto-heartbeats + audits + standardises errors. */
  async function withAudit<T>(
    action: string,
    args: Record<string, unknown>,
    fn: () => T | Promise<T>
  ): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
    heartbeat(db, sessionId);
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
      },
    },
    async ({ name, description }) => {
      const r = await withAudit(
        "register_session",
        { name, description },
        () =>
          registerSession(db, {
            id: sessionId,
            name,
            description: description ?? null,
            project_dir: projectDir,
          })
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
      return json(r.ok ? { message: r.result } : { error: r.error });
    }
  );

  // 9. check_inbox
  server.registerTool(
    "check_inbox",
    {
      description:
        "Check questions other sessions have asked you that are still pending a reply.",
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

  // 12. get_graph
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
  await server.connect(transport);
  logger.info({ sessionId }, "mcp connected via stdio");

  // Stale sessions clean up naturally via heartbeat timeout; nothing to do on
  // process exit (process termination is the heartbeat-loss signal).
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
