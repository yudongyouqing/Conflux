import type { ModelMessage, ToolSet } from "ai" with { "resolution-mode": "import" };
import { z } from "zod";
import type { DB } from "./db.js";
import type { Agent } from "@muiltchat/shared";
import { registerSession, listSessions } from "./sessions.js";
import { queryContext } from "./search.js";
import { askSession, checkInbox, replyAsk } from "./messages.js";
import { publishContext } from "./context.js";
import { recordEdge } from "./graph.js";
import { resolveModel } from "./providers.js";
import { logger } from "../log.js";

export type AgentStreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown };

/**
 * Run an agent chat with a tool-use loop, driven by the Vercel AI SDK.
 * The agent can call cross-session tools (query_context, ask_session, ...)
 * to interact with external sessions; the SDK handles the multi-step loop
 * (stopWhen: stepCountIs(10)).
 *
 * Yields stream events: text tokens, tool_use, tool_result.
 * The SSE event protocol consumed by the frontend is unchanged.
 *
 * The `ai` package is ESM-only, so its values are loaded via dynamic
 * import() (Node caches the module after the first chat).
 */
export async function* runAgentChat(
  db: DB,
  agent: Agent,
  history: { role: "user" | "assistant"; content: string }[]
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  // Register agent as a session so it appears in the graph and can
  // participate in cross-session communication.
  const agentSessionId = `agent-${agent.id}`;
  registerSession(db, {
    id: agentSessionId,
    name: agent.name,
    description: agent.description ?? "Internal agent",
    project_dir: null,
  });

  const config = agent.model_config;

  const systemPrompt =
    agent.system_prompt +
    `\n\nYou are registered as session "${agentSessionId}" in the muiltchat cross-session network. ` +
    `You can use the provided tools to interact with other sessions (external AI coding assistants). ` +
    `Use them proactively when the user's question involves information that other sessions might have. ` +
    `After using tools, summarize the findings for the user. Be concise.`;

  logger.debug(
    { agentId: agent.id, provider: config.provider, model: config.model },
    "agent chat starting"
  );

  const { streamText, stepCountIs } = await import("ai");
  const [model, tools] = await Promise.all([
    resolveModel(config),
    defineTools(db, agentSessionId),
  ]);

  const result = streamText({
    model,
    instructions: systemPrompt,
    // {role, content: string} is a valid ModelMessage at runtime; the union
    // type is just too wide for direct structural assignment.
    messages: history as ModelMessage[],
    tools,
    stopWhen: stepCountIs(10),
    maxOutputTokens: config.max_tokens ?? 4096,
    temperature: config.temperature,
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        yield { type: "text", content: part.text };
        break;
      case "tool-call":
        yield {
          type: "tool_use",
          name: part.toolName,
          input: (part.input ?? {}) as Record<string, unknown>,
        };
        break;
      case "tool-result":
        yield { type: "tool_result", name: part.toolName, result: part.output };
        break;
      case "tool-error":
        // execute() itself threw (not a domain error); surface it as a
        // tool_result so the frontend still renders the step.
        yield {
          type: "tool_result",
          name: part.toolName,
          result: {
            error: part.error instanceof Error ? part.error.message : String(part.error),
          },
        };
        break;
      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  // Record edge from agent session to "web-ui" for graph visualization
  recordEdge(db, agentSessionId, "web-ui");
}

// ---- Tool definitions ----

/**
 * Wrap a tool body so execution errors become {error} results instead of
 * crashing the stream — same semantics as the previous hand-rolled loop.
 */
function safe(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "tool execution error");
    return { error: msg };
  }
}

async function defineTools(db: DB, sessionId: string): Promise<ToolSet> {
  const { tool } = await import("ai");
  return {
    list_sessions: tool({
      description:
        "List active external sessions (AI coding assistants like Claude Code). Use to discover who you can communicate with.",
      inputSchema: z.object({}),
      execute: async () => safe(() => listSessions(db, { status: "active" })),
    }),
    query_context: tool({
      description:
        "Full-text search across all sessions' published context (decisions, code patterns, findings). Use to find information other sessions have shared.",
      inputSchema: z.object({
        query: z.string().optional().describe("FTS search query"),
        session_id: z.string().optional().describe("Restrict to a specific session"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
      execute: async ({ query, session_id, tags, limit }) =>
        safe(() =>
          queryContext(db, {
            query,
            session_id,
            tags,
            limit: limit ?? 20,
          })
        ),
    }),
    ask_session: tool({
      description:
        "Ask another session a question asynchronously. They will see it in their inbox and may reply later.",
      inputSchema: z.object({
        to_session: z.string().describe("Target session ID"),
        question: z.string().describe("The question"),
      }),
      execute: async ({ to_session, question }) =>
        safe(() => {
          const msg = askSession(db, {
            from_session: sessionId,
            to_session,
            question,
          });
          return { message_id: msg.id, status: "sent" };
        }),
    }),
    check_inbox: tool({
      description:
        "Check if other sessions have asked you questions that are pending a reply.",
      inputSchema: z.object({}),
      execute: async () => safe(() => checkInbox(db, sessionId)),
    }),
    reply_ask: tool({
      description: "Reply to a question from another session.",
      inputSchema: z.object({
        message_id: z.number().describe("The message ID to reply to"),
        reply: z.string().describe("Your reply"),
      }),
      execute: async ({ message_id, reply }) =>
        safe(() => {
          const msg = replyAsk(db, message_id, sessionId, reply);
          return { message_id: msg.id, status: "replied" };
        }),
    }),
    publish_context: tool({
      description:
        "Publish a piece of context (finding, decision, pattern) for other sessions to discover via search.",
      inputSchema: z.object({
        title: z.string().describe("Short title"),
        content: z.string().describe("The context body"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
      }),
      execute: async ({ title, content, tags }) =>
        safe(() => {
          const entry = publishContext(db, {
            session_id: sessionId,
            title,
            content,
            tags: tags ?? null,
          });
          return { entry_id: entry.id, published: true };
        }),
    }),
  };
}
