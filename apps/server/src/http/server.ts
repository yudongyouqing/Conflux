import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "fs";
import { resolve } from "path";

import { resolveConfig, type Scope, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from "../config.js";
import { openDb, type DB } from "../core/db.js";
import {
  registerSession,
  listSessions,
  heartbeat,
  getSession,
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
import { logger } from "../log.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  scope?: Scope;
  overrideDataDir?: string;
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<FastifyInstance> {
  const config = resolveConfig(opts.scope ?? "global", opts.overrideDataDir);
  const db: DB = openDb(config);
  const host = opts.host ?? DEFAULT_HTTP_HOST;
  const port = opts.port ?? DEFAULT_HTTP_PORT;

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

  const app = Fastify({
    logger: false, // we use our own pino sink writing to stderr
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

  // Serve the built frontend (apps/web/dist/) if it exists.
  // __dirname is apps/server/{src,dist}/http — four levels up reaches the repo
  // root, then into apps/web/dist.
  const webDist = resolve(__dirname, "../../../../apps/web/dist");
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
    args?: Record<string, unknown>
  ) {
    const message = err instanceof Error ? err.message : String(err);
    if (sid && action) {
      logAudit(db, {
        caller_session: sid,
        interface: "http",
        action,
        args: args ?? {},
        result: { error: message },
      });
    }
    const code =
      message.includes("not owner") || message.includes("not the addressee")
        ? 403
        : message.includes("not found") || message.includes("missing") || message.includes("cannot ask yourself")
          ? 400
          : 500;
    return reply.code(code).send({ error: message });
  }

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
      const sessions = listSessions(db, { status });
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
      if (!entry) return reply.code(404).send({ error: "not found" });
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
      if (!ok) return reply.code(404).send({ error: "not found" });
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
      audit(sid, "ask_session", { to_session: req.body.to_session }, { message_id: msg.id });
      return reply.send({ message: msg });
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
      if (!agent) return reply.code(404).send({ error: "agent not found" });
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
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      return reply.send({ agent });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // DELETE /agents/:id
  app.delete<{ Params: { id: string } }>("/agents/:id", {}, async (req, reply) => {
    try {
      const ok = deleteAgent(db, Number(req.params.id));
      if (!ok) return reply.code(404).send({ error: "agent not found" });
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
    if (!agent) return reply.code(404).send({ error: "agent not found" });

    if (!hasApiKey(agent.model_config.provider)) {
      const entry = providerRegistry[agent.model_config.provider];
      const envVar = entry?.envVar ?? `${agent.model_config.provider.toUpperCase()}_API_KEY`;
      return reply.code(503).send({
        error: `${agent.model_config.provider} API key not configured. Set ${envVar} environment variable before starting the server.`,
      });
    }

    // Create or reuse conversation
    let conv;
    if (req.body.conversation_id) {
      conv = getConversation(db, req.body.conversation_id);
      if (!conv) return reply.code(404).send({ error: "conversation not found" });
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
      if (!ok) return reply.code(404).send({ error: "conversation not found" });
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
    if (!peer) return reply.code(400).send({ error: "missing peer query param" });
    try {
      const messages = listPeerMessages(db, WEB_CONSOLE_ID, peer);
      return reply.send({ messages });
    } catch (err) {
      return sendError(reply, err, WEB_CONSOLE_ID, "web_peer_messages");
    }
  });

  // POST /web/ask — ask a session from the web console (Drawer input box)
  app.post<{ Body: { to_session: string; question: string } }>("/web/ask", {
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
    try {
      heartbeat(db, WEB_CONSOLE_ID);
      const msg = askSession(db, {
        from_session: WEB_CONSOLE_ID,
        to_session: req.body.to_session,
        question: req.body.question,
      });
      logAudit(db, {
        caller_session: WEB_CONSOLE_ID,
        interface: "http",
        action: "web_ask",
        args: { to_session: req.body.to_session },
        result: { message_id: msg.id },
      });
      return reply.send({ message: msg });
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

  await app.listen({ host, port });
  logger.info({ host, port, dataDir: config.dataDir }, "http server listening");

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
