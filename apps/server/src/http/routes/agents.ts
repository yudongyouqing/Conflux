import type { FastifyInstance } from "fastify";
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  type ModelConfig,
} from "../../core/agents.js";
import {
  createConversation,
  getConversation,
  listConversations,
  addTurn,
  getTurns,
  deleteConversation,
} from "../../core/conversations.js";
import { hasApiKey, providerRegistry } from "../../core/providers.js";
import { runAgentChat } from "../../core/agent-runner.js";
import { logger } from "../../log.js";
import type { ServerContext } from "../context.js";

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

export function registerAgentRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendError, sendHttpError } = ctx;

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
}
