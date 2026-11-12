import type { ManagedCodexEvent } from "./types.js";

/**
 * Normalize official app-server notifications into Conflux's replayable
 * event vocabulary. Pure functions — the manager owns state and effects.
 *
 * Terminal semantics: only `turn/completed` is terminal for a run. The
 * final text is the LAST completed agentMessage ITEM by item id — deltas are
 * progress display only and never concatenated onto the final text (the
 * completed item already contains the whole message; concatenating both
 * would duplicate it).
 */

type EventBody = Pick<ManagedCodexEvent, "type" | "payload">;

interface NotificationParams {
  threadId?: string;
  turnId?: string;
}

function idsOf(params: unknown): NotificationParams {
  if (typeof params === "object" && params !== null) {
    const p = params as Record<string, unknown>;
    return {
      threadId: typeof p.threadId === "string" ? p.threadId : undefined,
      turnId: typeof p.turnId === "string" ? p.turnId : undefined,
    };
  }
  return {};
}

/** Return the normalized event for a notification, or null to ignore. */
export function normalizeNotification(method: string, params: unknown): EventBody | null {
  switch (method) {
    case "thread/started":
      return { type: "status", payload: { phase: "thread_started" } };
    case "turn/started":
      return { type: "status", payload: { phase: "turn_started" } };
    case "turn/completed":
      return terminalEvent(params);
    case "item/started":
    case "item/completed": {
      const item = itemOf(params);
      if (!item) return null;
      const phase = method === "item/started" ? "started" : "completed";
      if (item.type === "agentMessage") {
        return {
          type: "text",
          payload:
            phase === "completed"
              ? { phase, itemId: item.id, text: item.text }
              : { phase, itemId: item.id },
        };
      }
      if (item.type === "commandExecution") {
        return {
          type: "tool",
          payload: {
            phase,
            itemId: item.id,
            tool: "commandExecution",
            command: item.command,
            exitCode: item.exitCode,
          },
        };
      }
      if (item.type === "fileChange") {
        return { type: "tool", payload: { phase, itemId: item.id, tool: "fileChange" } };
      }
      if (item.type === "mcpToolCall") {
        return {
          type: "tool",
          payload: { phase, itemId: item.id, tool: "mcpToolCall", server: item.server, name: item.tool },
        };
      }
      return { type: "status", payload: { phase, itemId: item.id, itemType: item.type } };
    }
    case "item/agentMessage/delta": {
      const p = params as { delta?: unknown } | null;
      return {
        type: "text",
        payload: { phase: "delta", delta: typeof p?.delta === "string" ? p.delta : "" },
      };
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      // Reasoning stream is deliberately NOT persisted (privacy + replay
      // size); acknowledging it as a status blip keeps ordering debuggable.
      return { type: "status", payload: { phase: "reasoning_delta" } };
    case "error": {
      const p = params as { error?: { message?: unknown }; willRetry?: unknown } | null;
      return {
        type: "error",
        payload: {
          message: typeof p?.error?.message === "string" ? p.error.message : "unknown error",
          willRetry: p?.willRetry === true,
        },
      };
    }
    default:
      return null;
  }
}

function terminalEvent(params: unknown): EventBody {
  const p = (params ?? {}) as { turn?: { status?: unknown; error?: { message?: unknown } | null } };
  const status = typeof p.turn?.status === "string" ? p.turn.status : "unknown";
  const message =
    typeof p.turn?.error?.message === "string" ? p.turn.error.message : undefined;
  return { type: "status", payload: { phase: "turn_completed", turnStatus: status, ...(message ? { error: message } : {}) } };
}

interface ItemShape {
  type: string;
  id: string;
  text?: string;
  command?: string;
  exitCode?: number | null;
  server?: string;
  tool?: string;
}

function itemOf(params: unknown): ItemShape | null {
  const p = params as { item?: unknown } | null;
  const raw = p?.item;
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.type !== "string" || typeof item.id !== "string") return null;
  return {
    type: item.type,
    id: item.id,
    text: typeof item.text === "string" ? item.text : undefined,
    command: typeof item.command === "string" ? item.command : undefined,
    exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    server: typeof item.server === "string" ? item.server : undefined,
    tool: typeof item.tool === "string" ? item.tool : undefined,
  };
}

/** Is this notification a terminal turn completion (drives run finality)? */
export function isTerminalNotification(method: string): boolean {
  return method === "turn/completed";
}

/** Extract the agent-visible final message from a completed agentMessage item. */
export function finalTextFromItem(item: unknown): string | null {
  const shape = itemOf({ item });
  return shape?.type === "agentMessage" && typeof shape.text === "string" ? shape.text : null;
}

/**
 * Final text for a turn: the LAST completed agentMessage item wins; deltas
 * are display-only and never concatenated (the completed item already holds
 * the full message — merging both would duplicate it).
 */
export function mergeFinalText(completedAgentTexts: string[]): string | null {
  for (let i = completedAgentTexts.length - 1; i >= 0; i--) {
    if (completedAgentTexts[i].length > 0) return completedAgentTexts[i];
  }
  return null;
}
