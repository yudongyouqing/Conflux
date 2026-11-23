import type { HandoffResult, ManagedDeliveryMode } from "@conflux/shared";
import type { DB } from "./db.js";
import { publishContext, type ContextEntry } from "./context.js";
import { queryContext } from "./search.js";
import { getSession } from "./sessions.js";
import { askAndMaybeWake } from "./ask.js";

/**
 * Cross-session / cross-provider context handoff: assembles a bounded
 * structured dossier (pinned/decision/artifact memory + recent replied
 * exchanges + optional workflow step outputs) so Claude, Codex, Antigravity,
 * or external terminal sessions can hand off work cleanly without losing key
 * decisions or overflowing context budgets.
 */

export const DEFAULT_HANDOFF_MAX_CHARS = 12_000;

export interface BuildHandoffInput {
  from_sessions?: string[];
  room_id?: number | null;
  workflow_step_outputs?: Array<{ step_key: string; title: string; output: string }>;
  note?: string;
  max_chars?: number;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 16))}\n…[已截断]`;
}

export function buildHandoffSummary(db: DB, input: BuildHandoffInput): string {
  const maxChars = Math.min(Math.max(input.max_chars ?? DEFAULT_HANDOFF_MAX_CHARS, 500), 40_000);
  const sections: string[] = [];
  let used = 0;

  const pushSection = (header: string, body: string): void => {
    if (!body.trim() || used >= maxChars) return;
    const remaining = maxChars - used;
    const block = `### ${header}\n${body.trim()}\n`;
    const clipped = clip(block, remaining);
    sections.push(clipped);
    used += clipped.length;
  };

  if (input.note?.trim()) {
    pushSection("交接说明", input.note.trim());
  }

  // 1. Upstream workflow step outputs (highest signal when handing off in a DAG)
  if (input.workflow_step_outputs && input.workflow_step_outputs.length > 0) {
    const lines = input.workflow_step_outputs.map(
      (s) => `- **${s.title} (${s.step_key})**:\n${clip(s.output, 2500)}`,
    );
    pushSection("上游步骤产出", lines.join("\n\n"));
  }

  // 2. Pinned & structured shared memory (decisions / artifacts / notes)
  const memoryMap = new Map<number, ContextEntry>();
  if (input.room_id) {
    for (const e of queryContext(db, { room_id: input.room_id, limit: 20 })) {
      memoryMap.set(e.id, e);
    }
  }
  for (const sid of input.from_sessions ?? []) {
    for (const e of queryContext(db, { session_id: sid, limit: 15 })) {
      memoryMap.set(e.id, e);
    }
  }
  const memories = [...memoryMap.values()]
    .filter((m) => m.kind !== "handoff")
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));

  if (memories.length > 0) {
    const lines = memories.slice(0, 12).map((m) => {
      const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
      const badge = m.pinned ? "[置顶] " : "";
      return `- ${badge}[${m.kind ?? "note"}] **${m.title}**${tagStr}\n  ${clip(m.content, 1200)}`;
    });
    pushSection("共享记忆与关键决策", lines.join("\n"));
  }

  // 3. Recent replied exchanges from source sessions (or room)
  const sources = input.from_sessions ?? [];
  const exchangeRows: Array<{
    from_session: string;
    to_session: string;
    question: string;
    reply: string | null;
  }> = [];

  if (input.room_id) {
    const rows = db
      .prepare(
        `SELECT from_session, to_session, question, reply FROM messages
         WHERE room_id = ? AND reply IS NOT NULL
         ORDER BY id DESC LIMIT 8`,
      )
      .all(input.room_id) as typeof exchangeRows;
    exchangeRows.push(...rows.reverse());
  } else if (sources.length > 0) {
    const placeholders = sources.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT from_session, to_session, question, reply FROM messages
         WHERE (from_session IN (${placeholders}) OR to_session IN (${placeholders}))
           AND reply IS NOT NULL
         ORDER BY id DESC LIMIT 8`,
      )
      .all(...sources, ...sources) as typeof exchangeRows;
    exchangeRows.push(...rows.reverse());
  }

  if (exchangeRows.length > 0) {
    const lines = exchangeRows.map((m) => {
      const fromName = getSession(db, m.from_session)?.name ?? m.from_session.slice(0, 8);
      const toName = getSession(db, m.to_session)?.name ?? m.to_session.slice(0, 8);
      return `- **${fromName} → ${toName}**: ${clip(m.question, 300)}\n  ↳ ${clip(m.reply ?? "", 800)}`;
    });
    pushSection("近期对话结论", lines.join("\n"));
  }

  if (sections.length === 0) {
    return "（暂无可汇总的历史记忆或回复，请直接按新任务指令继续。）";
  }

  return sections.join("\n").trim();
}

export interface HandoffContextInput extends BuildHandoffInput {
  from_session: string;
  to_session: string;
  title?: string;
  prompt?: string;
  delivery_mode?: ManagedDeliveryMode;
  deliver?: boolean;
}

export async function handoffContext(db: DB, input: HandoffContextInput): Promise<HandoffResult> {
  const fromSession = getSession(db, input.from_session);
  const toSession = getSession(db, input.to_session);
  if (!toSession) {
    throw Object.assign(new Error(`target session not found: ${input.to_session}`), {
      statusCode: 404,
    });
  }

  const fromSessions = input.from_sessions?.length ? input.from_sessions : [input.from_session];
  const summary = buildHandoffSummary(db, {
    ...input,
    from_sessions: fromSessions,
  });

  const title =
    input.title?.trim() ||
    `交接：${fromSession?.name ?? input.from_session.slice(0, 8)} → ${toSession.name}`;

  const entry = publishContext(db, {
    session_id: input.from_session,
    room_id: input.room_id ?? toSession.chat_room_id ?? null,
    kind: "handoff",
    title,
    content: summary,
    tags: ["handoff", `to:${input.to_session}`],
  });

  if (input.deliver === false) {
    return {
      context_entry: entry,
      message_id: null,
      delivered: false,
      delivery_method: "stored_only",
      summary_chars: summary.length,
    };
  }

  const promptBody = [
    `[上下文交接 #${entry.id}] 来自 ${fromSession?.name ?? input.from_session}`,
    input.prompt?.trim() ? `\n**接下来需要你完成**：\n${input.prompt.trim()}` : "",
    `\n---\n${summary}`,
  ]
    .filter(Boolean)
    .join("\n");

  const outcome = await askAndMaybeWake(db, {
    from_session: input.from_session,
    to_session: input.to_session,
    question: promptBody,
    room_id: input.room_id ?? toSession.chat_room_id ?? null,
    delivery_mode: input.delivery_mode,
  });

  return {
    context_entry: entry,
    message_id: outcome.message.id,
    delivered: outcome.wake.woke,
    delivery_method: outcome.wake.woke
      ? (outcome.wake.command ?? "woken")
      : (outcome.wake.reason ?? "queued"),
    summary_chars: summary.length,
  };
}
