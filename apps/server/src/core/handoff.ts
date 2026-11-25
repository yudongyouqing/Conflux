import type { HandoffResult, ManagedDeliveryMode } from "@conflux/shared";
import type { DB } from "./db.js";
import { publishContext, queryContext } from "./context.js";
import { askThread } from "./messages.js";
import { getThread, listThreadRuns } from "./threads/store.js";

const DEFAULT_MAX_CHARS = 8000;

export function buildHandoffSummary(
  db: DB,
  input: {
    from_threads: string[];
    project_id?: number | null;
    room_id?: number | null;
    note?: string;
    workflow_step_outputs?: Array<{ step_key: string; title: string; output: string }>;
    max_chars?: number;
  },
): string {
  const maxChars = Math.max(500, Math.min(input.max_chars ?? DEFAULT_MAX_CHARS, 30_000));
  const sections: string[] = [];

  if (input.note?.trim()) {
    sections.push(`## 交接说明\n${input.note.trim()}`);
  }

  if (input.workflow_step_outputs && input.workflow_step_outputs.length > 0) {
    const body = input.workflow_step_outputs
      .map((s) => `### ${s.title} (${s.step_key})\n${s.output.slice(0, 2000)}`)
      .join("\n\n");
    sections.push(`## 上游工作流产出\n${body}`);
  }

  const pinned = queryContext(db, {
    ...(input.room_id ? { room_id: input.room_id } : input.project_id ? { project_id: input.project_id } : {}),
    pinned: true,
    limit: 12,
  });
  if (pinned.length > 0) {
    sections.push(
      `## 置顶共享记忆\n${pinned
        .map((c) => `- [${c.kind}] **${c.title}**：${c.content.slice(0, 600)}`)
        .join("\n")}`,
    );
  }

  for (const tid of input.from_threads) {
    const thread = getThread(db, tid);
    const label = thread ? `${thread.name} (${thread.runtime})` : tid;
    const runs = listThreadRuns(db, tid, 5).reverse();
    if (runs.length > 0) {
      const lines = runs.map(
        (r, idx) =>
          `${idx + 1}. 问：${r.prompt.slice(0, 240)}\n   答：${(r.final_text ?? r.error_code ?? "").slice(0, 800)}`,
      );
      sections.push(`## 来自 ${label} 的近期执行\n${lines.join("\n")}`);
    }
  }

  const merged = sections.join("\n\n").trim() || "（无前序上下文记录）";
  return merged.length > maxChars ? `${merged.slice(0, maxChars)}\n…（已按长度截断）` : merged;
}

export async function handoffContext(
  db: DB,
  input: {
    from_thread: string;
    from_threads?: string[];
    to_thread: string;
    project_id?: number | null;
    room_id?: number | null;
    title?: string;
    note?: string;
    prompt?: string;
    max_chars?: number;
    delivery_mode?: ManagedDeliveryMode;
    deliver?: boolean;
  },
): Promise<HandoffResult> {
  const fromThread = getThread(db, input.from_thread);
  const toThread = getThread(db, input.to_thread);
  if (!toThread) {
    throw Object.assign(new Error(`target thread not found: ${input.to_thread}`), { statusCode: 404 });
  }
  const sources =
    input.from_threads && input.from_threads.length > 0
      ? input.from_threads
      : [input.from_thread];
  const projectId = input.project_id ?? toThread.project_id ?? fromThread?.project_id ?? null;
  const roomId = input.room_id ?? toThread.room_ids?.[0] ?? null;

  const summary = buildHandoffSummary(db, {
    from_threads: sources,
    project_id: projectId,
    room_id: roomId,
    note: input.note,
    max_chars: input.max_chars,
  });

  const title =
    input.title?.trim() ||
    `交接：${fromThread?.name ?? input.from_thread.slice(0, 8)} → ${toThread.name}`;

  const entry = publishContext(db, {
    thread_id: input.from_thread,
    project_id: projectId,
    room_id: roomId,
    kind: "handoff",
    title,
    content: summary,
    tags: ["handoff", `to:${toThread.id}`],
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

  const body = [
    `[上下文交接 #${entry.id}] 来自 ${fromThread?.name ?? input.from_thread}`,
    input.prompt?.trim() ? `\n**接下来需要你完成**：\n${input.prompt.trim()}` : "",
    `\n---\n${summary}`,
  ]
    .filter(Boolean)
    .join("\n");

  const outcome = await askThread(db, {
    from_thread: input.from_thread,
    to_thread: toThread.id,
    question: body,
    room_id: roomId,
    delivery_mode: input.delivery_mode,
  });

  return {
    context_entry: entry,
    message_id: outcome.message.id,
    delivered: outcome.delivered,
    delivery_method: outcome.delivery_method,
    summary_chars: summary.length,
  };
}
