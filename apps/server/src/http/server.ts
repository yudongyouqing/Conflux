import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "fs";
import { resolve } from "path";

import {
  resolveConfig,
  resolveHttpHost,
  resolveHttpPort,
  type Scope,
} from "../config.js";
import {
  openDb,
  publicError,
  stopWalCheckpoint,
  type DB,
  type PublicErrorCode,
} from "../core/db.js";
import {
  registerSession,
  listSessions,
  sessionBusy,
  heartbeat,
  getSession,
  markStaleSessions,
  pruneAbandonedSessions,
} from "../core/sessions.js";
import {
  publishContext,
  updateContext,
  deleteContext,
  listMyContext,
  getContext,
} from "../core/context.js";
import { queryContext } from "../core/search.js";
import {
  askSession,
  checkInbox,
  replyAsk,
  checkReplies,
  getMessage,
  listMessages,
  listPeerMessages,
  listEdgeMessages,
  getEdge,
} from "../core/messages.js";
import { getGraph } from "../core/graph.js";
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  type ModelConfig,
} from "../core/agents.js";
import {
  createConversation,
  getConversation,
  listConversations,
  addTurn,
  getTurns,
  deleteConversation,
} from "../core/conversations.js";
import { hasApiKey, providerRegistry } from "../core/providers.js";
import { runAgentChat } from "../core/agent-runner.js";
import { logAudit, queryAudit } from "../core/audit.js";
import {
  RUNTIMES,
  createRuntimeAgent,
  deleteRuntimeAgent,
  listRuntimeAgentsWithLiveness,
  startRuntimeAgent,
  tickScheduledAgents,
} from "../core/runtime-agents.js";
import { wakeSessionForMail } from "../core/wake/index.js";
import {
  getAutoWake,
  getTerminalSettings,
  saveTerminalSettings,
  setAutoWake,
} from "../core/app-settings.js";
import { openInTerminal, resumeCommand, terminalOptions } from "../core/terminal.js";
import {
  probeRuntimePids,
  reconcileRuntimeLiveness,
  type RuntimePidSnapshot,
} from "../core/liveness.js";
import { expireMcpLeases } from "../core/mcp-liveness.js";
import { refreshCodexSessionTitles } from "../core/codex-titles.js";
import type { TerminalSettings } from "@muiltchat/shared";
import { logger } from "../log.js";
import { exportData, importData, type ImportConflictStrategy } from "../core/data-transfer.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  scope?: Scope;
  overrideDataDir?: string;
}

export type RuntimePidProbe = () => Promise<RuntimePidSnapshot | null>;

export async function reconcileRuntimeState(
  db: DB,
  probe: RuntimePidProbe = probeRuntimePids,
  now: Date = new Date()
): Promise<{ expired: number; refreshed: number; reaped: number }> {
  const { expired } = expireMcpLeases(db, now);
  const livePids = await probe();
  if (!livePids) return { expired, refreshed: 0, reaped: 0 };
  const { refreshed, reaped } = reconcileRuntimeLiveness(db, livePids, now);
  return { expired, refreshed, reaped };
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<FastifyInstance> {
  const config = resolveConfig(opts.scope ?? "global", opts.overrideDataDir);
  const db: DB = openDb(config);
  const host = resolveHttpHost(opts.host);
  const port = resolveHttpPort(opts.port);
  const webDist = process.env.MUILTCHAT_WEB_DIST
    ? resolve(process.env.MUILTCHAT_WEB_DIST)
    : resolve(__dirname, "../../../web/dist");

  // ---- Web console identity ----
  // The browser UI acts as one fixed pseudo-session, so Drawer-originated
  // asks have a stable FK target and appear in the graph as a single node.
  const WEB_CONSOLE_ID = "web-console";
  registerSession(db, {
    id: WEB_CONSOLE_ID,
    name: "Web 控制台",
    description: "浏览器界面身份(从会话详情抽屉发起的对话)",
  });
  const consoleBeat = setInterval(() => {
    try {
      heartbeat(db, WEB_CONSOLE_ID);
    } catch {
      // transient sqlite lock — next tick retries
    }
  }, 30_000);
  consoleBeat.unref();

  // ---- zero-turn session reaper ----
  // Sessions abandoned mid-startup (open claude → immediately /resume) and
  // dead MCP temp placeholders go stale; sweep them out of the DB so the
  // graph doesn't accumulate zombie nodes.
  const sweepAbandoned = () => {
    try {
      markStaleSessions(db);
      pruneAbandonedSessions(db);
    } catch {
      // transient sqlite lock — next tick retries
    }
  };
  sweepAbandoned();
  const abandonedSweep = setInterval(sweepAbandoned, 60_000);
  abandonedSweep.unref();

  // ---- scheduled runtime agents (patrol pattern) ----
  // Every 30s: launch due, non-overlapping scheduled presets headless.
  const scheduleTick = () => {
    try {
      tickScheduledAgents(db);
    } catch {
      // transient sqlite lock — next tick retries
    }
  };
  const scheduleTimer = setInterval(scheduleTick, 30_000);
  scheduleTimer.unref();

  // ---- liveness probe (AgentRecall-style process scan) ----
  // MCP lease sessions are governed by connection heartbeats and lease TTL;
  // legacy rows without a lease are reconciled by runtime PID probing. If the
  // probe fails, the legacy heartbeat TTL remains the fallback.
  const livenessTick = async () => {
    try {
      await reconcileRuntimeState(db);
      // covers codex rows whose MCP child died but whose process still runs
      refreshCodexSessionTitles(db);
    } catch {
      // transient — next tick retries
    }
  };
  const livenessTimer = setInterval(livenessTick, 30_000);
  livenessTimer.unref();

  const app = Fastify({
    logger: false, // we use our own pino sink writing to stderr
  });

  const closeResources = () => {
    clearInterval(consoleBeat);
    clearInterval(abandonedSweep);
    clearInterval(scheduleTimer);
    clearInterval(livenessTimer);
    stopWalCheckpoint(db);
    if (db.open) db.close();
  };
  app.addHook("onClose", async () => {
    closeResources();
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "muiltchat",
        version: "0.1.0",
        description:
          "Cross-session context query and async messaging for AI coding assistants.",
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // CORS — allow the Vite dev server (and any local client) to call the API.
  await app.register(cors, { origin: true });

  // Serve the built frontend when either the packaged or repository path exists.
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      decorateReply: false,
    });
    logger.info({ webDist }, "serving frontend static files");
  }

  /** Resolve X-Session-Id header (or query) + ensure session exists in DB. */
  function requireSession(req: { headers: Record<string, string | string[] | undefined> }): string {
    const header = req.headers["x-session-id"];
    const sid = Array.isArray(header) ? header[0] : header;
    if (!sid || typeof sid !== "string") {
      throw httpError(400, "missing X-Session-Id header");
    }
    return sid;
  }

  function audit(
    sid: string,
    action: string,
    args: Record<string, unknown>,
    result: unknown
  ) {
    heartbeat(db, sid);
    logAudit(db, {
      caller_session: sid,
      interface: "http",
      action,
      args,
      result: safeSummary(result),
    });
  }

  /** Send an error reply AND audit the failure (when sid+action are known). */
  function sendError(
    reply: FastifyReply,
    err: unknown,
    sid?: string,
    action?: string,
    args?: Record<string, unknown>,
    statusOverride?: number
  ) {
    const mapped = publicError(err, { dataDir: config.dataDir, port });
    const status = statusOverride ?? publicStatus(err, mapped.code);
    logger.error(
      { err, sid, action, code: mapped.code, status },
      "http request failed"
    );
    if (sid && action) {
      try {
        logAudit(db, {
          caller_session: sid,
          interface: "http",
          action,
          args: args ?? {},
          result: { code: mapped.code },
        });
      } catch (auditError) {
        logger.warn({ err: auditError, action }, "failed to audit HTTP error");
      }
    }
    return reply.code(status).send({ ...mapped, error: mapped.message });
  }

  function sendHttpError(reply: FastifyReply, status: number, message: string) {
    const mapped = publicError(httpError(status, message), {
      dataDir: config.dataDir,
      port,
    });
    return reply.code(status).send({ ...mapped, error: mapped.message });
  }

  app.setNotFoundHandler((req, reply) =>
    sendError(reply, httpError(404, `route not found: ${req.method} ${req.url}`))
  );
  app.setErrorHandler((err, _req, reply) => {
    if (reply.sent) return;
    return sendError(reply, err);
  });

  // POST /sessions/register
  app.post<{ Body: RegisterBody }>("/sessions/register", {
    schema: {
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          session_id: { type: "string" },
        },
      },
    },
  }, async (req, reply) => {
    const sid = req.body.session_id || req.headers["x-session-id"] as string || uuidv4();
    try {
      const session = registerSession(db, {
        id: sid,
        name: req.body.name,
        description: req.body.description ?? null,
        project_dir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      });
      audit(sid, "register_session", { name: req.body.name }, { session_id: sid });
      reply.header("X-Session-Id", sid);
      return reply.send({ session_id: sid, session });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /sessions
  app.get<{ Querystring: { status?: string } }>("/sessions", {}, async (req, reply) => {
    try {
      const status = (req.query.status as "active" | "stale" | "ended" | "all" | undefined) ?? "active";
      const sessions = listSessions(db, { status }).map((s) => ({
        ...s,
        busy: sessionBusy(s.metadata),
      }));
      return reply.send({ sessions });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /context
  app.post<{ Body: ContextBody }>("/context", {
    schema: {
      body: {
        type: "object",
        required: ["title", "content"],
        properties: {
          title: { type: "string", maxLength: 300 },
          content: { type: "string", maxLength: 50000 },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entry = publishContext(db, {
        session_id: sid,
        title: req.body.title,
        content: req.body.content,
        tags: req.body.tags ?? null,
      });
      audit(sid, "publish_context", { title: req.body.title, tags: req.body.tags }, { entry_id: entry.id });
      return reply.send({ entry });
    } catch (err) {
      return sendError(reply, err, sid, "publish_context");
    }
  });

  // GET /context/mine
  app.get("/context/mine", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entries = listMyContext(db, sid);
      audit(sid, "list_my_context", {}, { count: entries.length });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err, sid, "list_my_context");
    }
  });

  // GET /context/query
  app.get<{ Querystring: QueryContextQs }>("/context/query", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entries = queryContext(db, {
        query: req.query.query,
        session_id: req.query.session_id,
        tags: req.query.tags ? String(req.query.tags).split(",") : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      audit(sid, "query_context", req.query as Record<string, unknown>, { count: entries.length });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err, sid, "query_context");
    }
  });

  // PUT /context/:id
  app.put<{ Params: { id: string }; Body: UpdateContextBody }>("/context/:id", {
    schema: {
      body: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 300 },
          content: { type: "string", maxLength: 50000 },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entry = updateContext(db, Number(req.params.id), sid, {
        title: req.body.title,
        content: req.body.content,
        tags: req.body.tags,
      });
      audit(sid, "update_context", { id: req.params.id }, entry ? { id: entry.id } : null);
      if (!entry) return sendHttpError(reply, 404, "not found");
      return reply.send({ entry });
    } catch (err) {
      return sendError(reply, err, sid, "update_context");
    }
  });

  // DELETE /context/:id
  app.delete<{ Params: { id: string } }>("/context/:id", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const ok = deleteContext(db, Number(req.params.id), sid);
      audit(sid, "delete_context", { id: req.params.id }, { ok });
      if (!ok) return sendHttpError(reply, 404, "not found");
      return reply.send({ deleted: true });
    } catch (err) {
      return sendError(reply, err, sid, "delete_context");
    }
  });

  // POST /messages/ask
  app.post<{ Body: AskBody }>("/messages/ask", {
    schema: {
      body: {
        type: "object",
        required: ["to_session", "question"],
        properties: {
          to_session: { type: "string" },
          question: { type: "string", maxLength: 20000 },
        },
      },
    },
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const msg = askSession(db, {
        from_session: sid,
        to_session: req.body.to_session,
        question: req.body.question,
      });
      let wake: { woke: boolean; reason?: string } = { woke: false, reason: "skipped" };
      try {
        wake = wakeSessionForMail(db, req.body.to_session);
      } catch {
        // best-effort auto-answer
      }
      audit(sid, "ask_session", { to_session: req.body.to_session }, { message_id: msg.id, wake });
      return reply.send({ message: msg, wake });
    } catch (err) {
      return sendError(reply, err, sid, "ask_session");
    }
  });

  // GET /messages/inbox
  app.get("/messages/inbox", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const inbox = checkInbox(db, sid);
      audit(sid, "check_inbox", {}, { count: inbox.length });
      return reply.send({ inbox });
    } catch (err) {
      return sendError(reply, err, sid, "check_inbox");
    }
  });

  // POST /messages/:id/reply
  app.post<{ Params: { id: string }; Body: ReplyBody }>("/messages/:id/reply", {
    schema: {
      body: {
        type: "object",
        required: ["reply"],
        properties: {
          reply: { type: "string", maxLength: 20000 },
        },
      },
    },
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const msg = replyAsk(db, Number(req.params.id), sid, req.body.reply);
      audit(sid, "reply_ask", { id: req.params.id }, { message_id: msg.id });
      return reply.send({ message: msg });
    } catch (err) {
      return sendError(reply, err, sid, "reply_ask");
    }
  });

  // GET /messages/replies
  app.get<{ Querystring: { since?: string } }>("/messages/replies", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const replies = checkReplies(db, sid, req.query.since);
      audit(sid, "check_replies", { since: req.query.since }, { count: replies.length });
      return reply.send({ replies });
    } catch (err) {
      return sendError(reply, err, sid, "check_replies");
    }
  });

  // ---- Agents (internal agent definitions) ----

  // POST /agents
  app.post<{ Body: CreateAgentBody }>("/agents", {
    schema: {
      body: {
        type: "object",
        required: ["name", "system_prompt", "model_config"],
        properties: {
          name: { type: "string", maxLength: 200 },
          system_prompt: { type: "string", maxLength: 50000 },
          model_config: {
            type: "object",
            required: ["provider", "model"],
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              temperature: { type: "number" },
              max_tokens: { type: "number" },
            },
          },
          description: { type: "string", maxLength: 2000 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const agent = createAgent(db, {
        name: req.body.name,
        system_prompt: req.body.system_prompt,
        model_config: req.body.model_config,
        description: req.body.description ?? null,
      });
      return reply.send({ agent });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /agents
  app.get("/agents", {}, async (_req, reply) => {
    try {
      const agents = listAgents(db);
      return reply.send({ agents });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /agents/:id
  app.get<{ Params: { id: string } }>("/agents/:id", {}, async (req, reply) => {
    try {
      const agent = getAgent(db, Number(req.params.id));
      if (!agent) return sendHttpError(reply, 404, "agent not found");
      return reply.send({ agent });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // PUT /agents/:id
  app.put<{ Params: { id: string }; Body: UpdateAgentBody }>("/agents/:id", {
    schema: {
      body: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 200 },
          system_prompt: { type: "string", maxLength: 50000 },
          model_config: {
            type: "object",
            required: ["provider", "model"],
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              temperature: { type: "number" },
              max_tokens: { type: "number" },
            },
          },
          description: { type: "string", maxLength: 2000 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const agent = updateAgent(db, Number(req.params.id), {
        name: req.body.name,
        system_prompt: req.body.system_prompt,
        model_config: req.body.model_config as ModelConfig | undefined,
        description: req.body.description,
      });
      if (!agent) return sendHttpError(reply, 404, "agent not found");
      return reply.send({ agent });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // DELETE /agents/:id
  app.delete<{ Params: { id: string } }>("/agents/:id", {}, async (req, reply) => {
    try {
      const ok = deleteAgent(db, Number(req.params.id));
      if (!ok) return sendHttpError(reply, 404, "agent not found");
      return reply.send({ deleted: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Chat (SSE streaming) + Conversations ----

  // POST /agents/:id/chat — SSE streaming chat with an internal agent
  app.post<{ Params: { id: string }; Body: ChatBody }>("/agents/:id/chat", {
    schema: {
      body: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", maxLength: 20000 },
          conversation_id: { type: "number" },
        },
      },
    },
  }, async (req, reply) => {
    const agentId = Number(req.params.id);
    const agent = getAgent(db, agentId);
    if (!agent) return sendHttpError(reply, 404, "agent not found");

    if (!hasApiKey(agent.model_config.provider)) {
      const entry = providerRegistry[agent.model_config.provider];
      const envVar = entry?.envVar ?? `${agent.model_config.provider.toUpperCase()}_API_KEY`;
      return sendHttpError(
        reply,
        503,
        `${agent.model_config.provider} API key not configured. Set ${envVar} environment variable before starting the server.`
      );
    }

    // Create or reuse conversation
    let conv;
    if (req.body.conversation_id) {
      conv = getConversation(db, req.body.conversation_id);
      if (!conv) return sendHttpError(reply, 404, "conversation not found");
    } else {
      conv = createConversation(db, {
        agent_id: agentId,
        initiated_by: "web-ui",
        title: req.body.message.slice(0, 60),
      });
    }

    // Save user turn
    addTurn(db, { conversation_id: conv.id, role: "user", content: req.body.message });

    // Load full history
    const turns = getTurns(db, conv.id);
    const llmMessages = turns.map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    }));

    // SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.setTimeout(0); // disable request timeout for long streams

    const sse = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sse({ type: "start", conversation_id: conv.id });

    try {
      let fullResponse = "";

      for await (const event of runAgentChat(db, agent, llmMessages)) {
        switch (event.type) {
          case "text":
            fullResponse += event.content;
            sse({ type: "token", content: event.content });
            break;
          case "tool_use":
            sse({ type: "tool_use", name: event.name, input: event.input });
            break;
          case "tool_result":
            sse({ type: "tool_result", name: event.name, result: event.result });
            break;
        }
      }

      const assistantTurn = addTurn(db, {
        conversation_id: conv.id,
        role: "assistant",
        content: fullResponse || "(no response)",
      });

      sse({ type: "done", conversation_id: conv.id, turn_id: assistantTurn.id });
      logger.info({ agentId, convId: conv.id, responseLen: fullResponse.length }, "chat completed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, agentId }, "LLM stream error");
      sse({ type: "error", message: msg });
    } finally {
      reply.raw.end();
    }
  });

  // GET /agents/:id/conversations
  app.get<{ Params: { id: string } }>("/agents/:id/conversations", {}, async (req, reply) => {
    try {
      const conversations = listConversations(db, { agent_id: Number(req.params.id) });
      return reply.send({ conversations });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /conversations/:id/turns
  app.get<{ Params: { id: string } }>("/conversations/:id/turns", {}, async (req, reply) => {
    try {
      const turns = getTurns(db, Number(req.params.id));
      return reply.send({ turns });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // DELETE /conversations/:id
  app.delete<{ Params: { id: string } }>("/conversations/:id", {}, async (req, reply) => {
    try {
      const ok = deleteConversation(db, Number(req.params.id));
      if (!ok) return sendHttpError(reply, 404, "conversation not found");
      return reply.send({ deleted: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /settings — check API key status (derived from the provider registry)
  app.get("/settings", {}, async (_req, reply) => {
    const providers: Record<string, { configured: boolean }> = {};
    for (const [name, entry] of Object.entries(providerRegistry)) {
      providers[name] = { configured: entry.hasKey() };
    }
    return reply.send({ providers });
  });

  // ---- terminal settings (opener used by "open in terminal" + agent start) ----
  app.get("/settings/terminal", {}, async (_req, reply) => {
    try {
      return reply.send({
        terminal: getTerminalSettings(db),
        options: terminalOptions(),
        auto_wake: getAutoWake(db),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Body: Partial<TerminalSettings> & { auto_wake?: boolean } }>("/settings/terminal", {
    schema: {
      body: {
        type: "object",
        properties: {
          terminal: { type: "string", enum: ["wt", "powershell", "cmd", "wezterm"] },
          claude_path: { type: "string", maxLength: 500 },
          codex_path: { type: "string", maxLength: 500 },
          auto_wake: { type: "boolean" },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const terminal = saveTerminalSettings(db, req.body);
      if (typeof req.body.auto_wake === "boolean") setAutoWake(db, req.body.auto_wake);
      logAudit(db, { interface: "http", action: "save_terminal_settings", args: { terminal: terminal.terminal } });
      return reply.send({ terminal, auto_wake: getAutoWake(db) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /sessions/:id/open-terminal — open the session's conversation in a
  // new terminal window (claude --resume <id> / codex resume <id>)
  app.post<{ Params: { id: string } }>("/sessions/:id/open-terminal", {}, async (req, reply) => {
    try {
      const id = req.params.id;
      const session = getSession(db, id);
      if (!session) return sendHttpError(reply, 404, "session not found");
      if (id.startsWith("agent-")) {
        return sendHttpError(reply, 400, "internal agents have no terminal");
      }
      let runtime: "claude" | "codex" = "claude";
      try {
        const meta = session.metadata ? (JSON.parse(session.metadata) as Record<string, unknown>) : null;
        if (meta?.runtime === "codex") runtime = "codex";
      } catch {
        // malformed metadata — default runtime
      }
      const settings = getTerminalSettings(db);
      const executable = runtime === "codex" ? settings.codex_path : settings.claude_path;
      const result = openInTerminal(settings, {
        command: resumeCommand(runtime, id, executable),
        cwd: session.project_dir ?? undefined,
        title: `muiltchat · ${session.name}`,
      });
      heartbeat(db, id);
      logAudit(db, {
        interface: "http",
        action: "open_terminal",
        args: { session: id, runtime },
        result,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /graph — return nodes (sessions) + edges (communication links)
  app.get<{ Querystring: { status?: string } }>("/graph", {}, async (req, reply) => {
    try {
      const status = (req.query.status as "active" | "stale" | "ended" | "all" | undefined) ?? "active";
      const graph = getGraph(db, { status });
      return reply.send(graph);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /web/peer-messages?peer=<id> — two-way flow between the web console and a session
  app.get<{ Querystring: { peer?: string } }>("/web/peer-messages", {}, async (req, reply) => {
    const peer = req.query.peer;
    if (!peer) return sendHttpError(reply, 400, "missing peer query param");
    try {
      const messages = listPeerMessages(db, WEB_CONSOLE_ID, peer);
      return reply.send({ messages });
    } catch (err) {
      return sendError(reply, err, WEB_CONSOLE_ID, "web_peer_messages");
    }
  });

  // GET /messages/peers?a=<id>&b=<id> — two-way flow between any two sessions
  // (legacy pair view; the edge channel view below is the primary)
  app.get<{ Querystring: { a?: string; b?: string } }>("/messages/peers", {}, async (req, reply) => {
    const { a, b } = req.query;
    if (!a || !b) return sendHttpError(reply, 400, "missing a/b query params");
    try {
      const messages = listPeerMessages(db, a, b);
      return reply.send({ messages });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- edge channels (directed conversation channels) ----

  // GET /edges/:id/messages — the channel's exchange history
  app.get<{ Params: { id: string } }>("/edges/:id/messages", {}, async (req, reply) => {
    try {
      const edgeId = Number(req.params.id);
      const edge = getEdge(db, edgeId);
      if (!edge) return sendHttpError(reply, 404, "edge not found");
      return reply.send({
        edge: { id: edge.id, from: edge.from_session, to: edge.to_session },
        messages: listEdgeMessages(db, edgeId),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /edges/:id/ask — speak ON the channel (web console may only use
  // channels it initiated: edge.from === web-console)
  app.post<{ Params: { id: string }; Body: { question: string } }>("/edges/:id/ask", {
    schema: {
      body: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string", maxLength: 20000 } },
      },
    },
  }, async (req, reply) => {
    try {
      const edgeId = Number(req.params.id);
      const edge = getEdge(db, edgeId);
      if (!edge) return sendHttpError(reply, 404, "edge not found");
      if (edge.from_session !== WEB_CONSOLE_ID) {
        return sendHttpError(
          reply,
          403,
          `只读通道:${edge.from_session} 发起的对话只能由该会话发言`
        );
      }
      heartbeat(db, WEB_CONSOLE_ID);
      const msg = askSession(db, {
        from_session: WEB_CONSOLE_ID,
        to_session: edge.to_session,
        question: req.body.question,
      });
      let wake: { woke: boolean; reason?: string } = { woke: false, reason: "skipped" };
      try {
        wake = wakeSessionForMail(db, edge.to_session);
      } catch {
        // best-effort auto-answer
      }
      logAudit(db, {
        caller_session: WEB_CONSOLE_ID,
        interface: "http",
        action: "edge_ask",
        args: { edge: edgeId },
        result: { message_id: msg.id, wake },
      });
      return reply.send({ message: msg, wake });
    } catch (err) {
      return sendError(reply, err, WEB_CONSOLE_ID, "edge_ask");
    }
  });

  // ---- runtime agents (user-defined CLI agent presets: Claude Code / Codex) ----

  // GET /runtimes — catalog (supported CLIs) + configured presets
  app.get("/runtimes", {}, async (_req, reply) => {
    try {
      return reply.send({
        runtimes: RUNTIMES,
        agents: listRuntimeAgentsWithLiveness(db),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: RuntimeAgentBody }>("/runtimes", {
    schema: {
      body: {
        type: "object",
        required: ["name", "runtime"],
        properties: {
          name: { type: "string", maxLength: 100 },
          runtime: { type: "string", enum: ["claude", "codex"] },
          workdir: { type: "string", maxLength: 1000 },
          model: { type: "string", maxLength: 200 },
          base_url: { type: "string", maxLength: 1000 },
          api_key: { type: "string", maxLength: 500 },
          extra_env: { type: "string", maxLength: 10000 },
          instructions: { type: "string", maxLength: 20000 },
          interval_min: { type: "integer", minimum: 1, maximum: 10080 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const agent = createRuntimeAgent(db, req.body);
      logAudit(db, {
        interface: "http",
        action: "create_runtime_agent",
        args: { id: agent.id, runtime: agent.runtime },
      });
      return reply.code(201).send({ agent });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/runtimes/:id", {}, async (req, reply) => {
    try {
      const ok = deleteRuntimeAgent(db, Number(req.params.id));
      if (!ok) return sendHttpError(reply, 404, "runtime agent not found");
      logAudit(db, { interface: "http", action: "delete_runtime_agent", args: { id: req.params.id } });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /runtimes/:id/start — launch the preset in a new terminal window
  app.post<{ Params: { id: string } }>("/runtimes/:id/start", {}, async (req, reply) => {
    try {
      const result = startRuntimeAgent(db, Number(req.params.id));
      logAudit(db, {
        interface: "http",
        action: "start_runtime_agent",
        args: { id: req.params.id },
        result,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /web/ask — ask a session from the web console (Drawer input box).
  // Optional from_session lets the UI speak AS a CLI session ("let A ask B");
  // omitted, the sender is the web console itself.
  app.post<{ Body: { to_session: string; question: string; from_session?: string } }>("/web/ask", {
    schema: {
      body: {
        type: "object",
        required: ["to_session", "question"],
        properties: {
          to_session: { type: "string" },
          question: { type: "string", maxLength: 20000 },
          from_session: { type: "string" },
        },
      },
    },
  }, async (req, reply) => {
    try {
      let from = WEB_CONSOLE_ID;
      if (req.body.from_session && req.body.from_session !== WEB_CONSOLE_ID) {
        const sender = getSession(db, req.body.from_session);
        if (!sender) throw httpError(400, "from_session not found");
        if (sender.id === req.body.to_session) {
          throw httpError(400, "from_session and to_session must differ");
        }
        from = sender.id; // speak AS this session; do NOT heartbeat it (no fake liveness)
      } else {
        heartbeat(db, WEB_CONSOLE_ID);
      }
      const msg = askSession(db, {
        from_session: from,
        to_session: req.body.to_session,
        question: req.body.question,
      });
      // true auto-answer: if the addressee is offline, wake its conversation
      let wake: { woke: boolean; reason?: string } = { woke: false, reason: "skipped" };
      try {
        wake = wakeSessionForMail(db, req.body.to_session);
      } catch {
        // best-effort — the mail is still delivered by the notice/forwarding paths
      }
      logAudit(db, {
        caller_session: from,
        interface: "http",
        action: "web_ask",
        args: { to_session: req.body.to_session, from_session: from },
        result: { message_id: msg.id, wake },
      });
      return reply.send({ message: msg, wake });
    } catch (err) {
      return sendError(reply, err, WEB_CONSOLE_ID, "web_ask");
    }
  });

  // GET /messages — global message list with filters (for frontend message-flow viewer)
  app.get<{ Querystring: MessagesQs }>("/messages", {}, async (req, reply) => {
    try {
      const messages = listMessages(db, {
        from_session: req.query.from,
        to_session: req.query.to,
        status: (req.query.status as never) ?? undefined,
        since: req.query.since,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.send({ messages });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /data/export - portable, secret-free database export
  app.get<{ Querystring: DataExportQs }>("/data/export", {}, async (req, reply) => {
    const scope = parseDataScope(req.query.scope);
    if (!scope) return sendHttpError(reply, 400, "scope must be global or project");
    try {
      const bundle = exportData(db, {
        scope,
        projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      });
      logAudit(db, {
        interface: "http",
        action: "export_data",
        args: { scope },
        result: dataTransferSummary(bundle),
      });
      reply.header("Content-Disposition", 'attachment; filename="conflux-data-v1.json"');
      return reply.send(bundle);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /data/import - validate and import one portable bundle atomically
  app.post<{ Body: DataImportBody }>("/data/import", {
    schema: {
      body: {
        type: "object",
        required: ["bundle"],
        additionalProperties: false,
        properties: {
          bundle: { type: "object" },
          conflict: { type: "string", enum: ["skip", "overwrite", "copy"] },
        },
      },
    },
  }, async (req, reply) => {
    const conflict = req.body.conflict ?? "skip";
    if (!isImportConflictStrategy(conflict)) {
      return sendHttpError(reply, 400, "conflict must be skip, overwrite, or copy");
    }
    try {
      const result = importData(db, req.body.bundle, {
        conflict,
        projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      });
      logAudit(db, {
        interface: "http",
        action: "import_data",
        args: { conflict },
        result: { ...result },
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, undefined, "import_data", { conflict }, 400);
    }
  });

  // GET /audit
  app.get<{ Querystring: AuditQs }>("/audit", {}, async (req, reply) => {
    try {
      const entries = queryAudit(db, {
        session: req.query.session,
        action: req.query.action,
        iface: req.query.interface as "mcp" | "http" | "cli" | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /healthz
  app.get("/healthz", {}, async (_req, reply) => reply.send({ ok: true }));

  try {
    await app.listen({ host, port });
  } catch (err) {
    closeResources();
    throw err;
  }
  logger.info(
    { webDist, host, port, dataDir: config.dataDir },
    "http server listening"
  );

  return app;
}

interface RegisterBody {
  name: string;
  description?: string;
  session_id?: string;
}
interface ContextBody {
  title: string;
  content: string;
  tags?: string[];
}
interface UpdateContextBody {
  title?: string;
  content?: string;
  tags?: string[];
}
interface AskBody {
  to_session: string;
  question: string;
}
interface RuntimeAgentBody {
  name: string;
  runtime: string;
  workdir?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  instructions?: string;
  interval_min?: number | null;
}
interface ReplyBody {
  reply: string;
}
interface QueryContextQs {
  query?: string;
  session_id?: string;
  tags?: string;
  limit?: string;
}
interface AuditQs {
  session?: string;
  action?: string;
  interface?: string;
  limit?: string;
}
interface MessagesQs {
  from?: string;
  to?: string;
  status?: string;
  since?: string;
  limit?: string;
}
interface DataExportQs {
  scope?: string;
}
interface DataImportBody {
  bundle: Record<string, unknown>;
  conflict?: string;
}
interface CreateAgentBody {
  name: string;
  system_prompt: string;
  model_config: ModelConfig;
  description?: string;
}
interface UpdateAgentBody {
  name?: string;
  system_prompt?: string;
  model_config?: ModelConfig;
  description?: string;
}
interface ChatBody {
  message: string;
  conversation_id?: number;
}

function httpError(code: number, message: string): { statusCode: number; message: string } {
  return { statusCode: code, message };
}

function safeSummary(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v)) return { count: v.length };
    if (typeof v.content === "string") {
      return { id: v.id, contentLen: v.content.length };
    }
    return v;
  }
  return { value: String(value).slice(0, 200) };
}

function publicStatus(error: unknown, code: PublicErrorCode): number {
  if (typeof error === "object" && error !== null) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) {
      return statusCode;
    }
  }
  switch (code) {
    case "DATA_LOCKED":
    case "PORT_IN_USE":
    case "SERVICE_UNAVAILABLE":
      return 503;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "FORBIDDEN":
      return 403;
    case "BAD_REQUEST":
      return 400;
    default:
      return 500;
  }
}

function parseDataScope(value: string | undefined): "global" | "project" | null {
  if (value === undefined || value === "global") return "global";
  if (value === "project") return "project";
  return null;
}

function isImportConflictStrategy(value: string): value is ImportConflictStrategy {
  return value === "skip" || value === "overwrite" || value === "copy";
}

function dataTransferSummary(bundle: {
  scope: string;
  sessions: unknown[];
  context_entries: unknown[];
  messages: unknown[];
  edges: unknown[];
  agents: unknown[];
  conversations: unknown[];
  turns: unknown[];
  runtime_agents: unknown[];
}): Record<string, unknown> {
  return {
    scope: bundle.scope,
    counts: {
      sessions: bundle.sessions.length,
      context_entries: bundle.context_entries.length,
      messages: bundle.messages.length,
      edges: bundle.edges.length,
      agents: bundle.agents.length,
      conversations: bundle.conversations.length,
      turns: bundle.turns.length,
      runtime_agents: bundle.runtime_agents.length,
    },
  };
}

// Minimal UUIDv4 (avoids extra import in this file).
function uuidv4(): string {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Re-export for completeness.
export { getContext, getMessage, getSession };
