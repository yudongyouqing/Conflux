import Anthropic from "@anthropic-ai/sdk";
import type { DB } from "./db.js";
import type { Agent } from "./agents.js";
import { registerSession } from "./sessions.js";
import { listSessions } from "./sessions.js";
import { queryContext } from "./search.js";
import { askSession, checkInbox, replyAsk } from "./messages.js";
import { publishContext } from "./context.js";
import { recordEdge } from "./graph.js";
import { logger } from "../log.js";

export type AgentStreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown };

/**
 * Run an agent chat with a tool-use loop. The agent can call cross-session
 * tools (query_context, ask_session, etc.) to interact with external sessions.
 *
 * Yields stream events: text tokens, tool_use, tool_result.
 * Terminates when the LLM stops calling tools (stop_reason: end_turn) or
 * max iterations is reached.
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });

  const tools = defineTools();

  // Build initial messages from conversation history
  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role,
    content: h.content,
  }));

  const systemPrompt =
    agent.system_prompt +
    `\n\nYou are registered as session "${agentSessionId}" in the muiltchat cross-session network. ` +
    `You can use the provided tools to interact with other sessions (external AI coding assistants). ` +
    `Use them proactively when the user's question involves information that other sessions might have. ` +
    `After using tools, summarize the findings for the user. Be concise.`;

  const maxTokens = agent.model_config.max_tokens ?? 4096;
  const maxIterations = 10;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    logger.debug(
      { agentId: agent.id, iteration, messageCount: messages.length },
      "agent tool-use loop iteration"
    );

    const stream = client.messages.stream({
      model: agent.model_config.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools,
    });

    // Yield text tokens as they arrive
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text", content: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();

    // Append full assistant response (preserves tool_use blocks for the API)
    messages.push({ role: "assistant", content: finalMessage.content });

    if (finalMessage.stop_reason !== "tool_use") {
      // Done — no more tool calls
      break;
    }

    // Execute tool calls
    const toolUseBlocks = finalMessage.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      yield {
        type: "tool_use",
        name: toolUse.name,
        input: (toolUse.input as Record<string, unknown>) ?? {},
      };

      const result = executeTool(db, agentSessionId, toolUse.name, toolUse.input);

      yield { type: "tool_result", name: toolUse.name, result };

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    // Feed tool results back for the next iteration
    messages.push({ role: "user", content: toolResults });
  }

  // Record edge from agent session to "web-ui" for graph visualization
  recordEdge(db, agentSessionId, "web-ui");
}

// ---- Tool definitions ----

function defineTools(): Anthropic.Tool[] {
  return [
    {
      name: "list_sessions",
      description:
        "List active external sessions (AI coding assistants like Claude Code). Use to discover who you can communicate with.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "query_context",
      description:
        "Full-text search across all sessions' published context (decisions, code patterns, findings). Use to find information other sessions have shared.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "FTS search query" },
          session_id: {
            type: "string",
            description: "Restrict to a specific session",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags",
          },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
    },
    {
      name: "ask_session",
      description:
        "Ask another session a question asynchronously. They will see it in their inbox and may reply later.",
      input_schema: {
        type: "object" as const,
        required: ["to_session", "question"],
        properties: {
          to_session: { type: "string", description: "Target session ID" },
          question: { type: "string", description: "The question" },
        },
      },
    },
    {
      name: "check_inbox",
      description:
        "Check if other sessions have asked you questions that are pending a reply.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "reply_ask",
      description: "Reply to a question from another session.",
      input_schema: {
        type: "object" as const,
        required: ["message_id", "reply"],
        properties: {
          message_id: { type: "number", description: "The message ID to reply to" },
          reply: { type: "string", description: "Your reply" },
        },
      },
    },
    {
      name: "publish_context",
      description:
        "Publish a piece of context (finding, decision, pattern) for other sessions to discover via search.",
      input_schema: {
        type: "object" as const,
        required: ["title", "content"],
        properties: {
          title: { type: "string", description: "Short title" },
          content: { type: "string", description: "The context body" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags",
          },
        },
      },
    },
  ];
}

// ---- Tool execution ----

function executeTool(
  db: DB,
  sessionId: string,
  name: string,
  input: unknown
): unknown {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_sessions":
        return listSessions(db, { status: "active" });

      case "query_context":
        return queryContext(db, {
          query: args.query as string | undefined,
          session_id: args.session_id as string | undefined,
          tags: args.tags as string[] | undefined,
          limit: (args.limit as number) ?? 20,
        });

      case "ask_session": {
        const msg = askSession(db, {
          from_session: sessionId,
          to_session: args.to_session as string,
          question: args.question as string,
        });
        return { message_id: msg.id, status: "sent" };
      }

      case "check_inbox":
        return checkInbox(db, sessionId);

      case "reply_ask": {
        const msg = replyAsk(
          db,
          args.message_id as number,
          sessionId,
          args.reply as string
        );
        return { message_id: msg.id, status: "replied" };
      }

      case "publish_context": {
        const entry = publishContext(db, {
          session_id: sessionId,
          title: args.title as string,
          content: args.content as string,
          tags: (args.tags as string[]) ?? null,
        });
        return { entry_id: entry.id, published: true };
      }

      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ toolName: name, err: msg }, "tool execution error");
    return { error: msg };
  }
}
