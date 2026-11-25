import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ContextKind, RuntimeId, WorkflowStepDefinition } from "@conflux/shared";
import { resolveConfig, type Scope } from "../config.js";
import { APP_VERSION } from "../version.js";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { ensureProjectForDir } from "../core/projects.js";
import {
  getThread,
  heartbeatThread,
  insertThread,
  isValidRuntime,
  listThreads,
  updateThread,
} from "../core/threads/store.js";
import { publishContext, queryContext } from "../core/context.js";
import { askThread, checkInbox, replyMessage } from "../core/messages.js";
import { reportRoomTaskDone, summonRoomAgent } from "../core/rooms.js";
import { handoffContext } from "../core/handoff.js";
import {
  createWorkflow,
  getWorkflowRun,
  onWorkflowStepMessageCompleted,
  startWorkflowRun,
} from "../core/workflows.js";
import { logger } from "../log.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function detectExternalRuntime(): RuntimeId {
  const explicit = process.env.CONFLUX_AGENT_RUNTIME?.trim().toLowerCase();
  if (isValidRuntime(explicit)) return explicit;
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_CI) return "codex";
  if (process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDECODE) return "claude";
  return "claude";
}

/**
 * Ensure an external MCP caller (or managed child's MCP process) is registered
 * in `agent_threads` under the matching `projects` entry by `project_dir`.
 */
export function ensureMcpThread(
  db: DB,
  opts: {
    id?: string;
    name?: string;
    project_dir?: string;
    runtime?: RuntimeId;
  } = {},
): string {
  const id =
    opts.id?.trim() ||
    process.env.CONFLUX_THREAD_ID?.trim() ||
    process.env.CONFLUX_SESSION_ID?.trim() ||
    `ext-${randomUUID().slice(0, 12)}`;

  const existing = getThread(db, id);
  const workdir = resolve(opts.project_dir?.trim() || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const project = ensureProjectForDir(db, workdir);

  if (existing) {
    heartbeatThread(db, existing.id);
    if (opts.name?.trim() && opts.name.trim() !== existing.name && existing.kind === "external") {
      updateThread(db, existing.id, { name: opts.name.trim(), project_id: project?.id ?? existing.project_id });
    }
    return existing.id;
  }

  const runtime = opts.runtime && isValidRuntime(opts.runtime) ? opts.runtime : detectExternalRuntime();
  const name = opts.name?.trim() || `${runtime}-${basename(workdir)}`;
  insertThread(db, {
    id,
    project_id: project?.id ?? null,
    name,
    kind: "external",
    runtime,
    state: "idle",
    approval_mode: "ask",
    workdir,
    pid: process.ppid || null,
  });
  return id;
}

export function createMcpServer(db: DB, defaultThreadId?: string): McpServer {
  let currentThreadId = defaultThreadId || ensureMcpThread(db);

  const server = new McpServer({
    name: "conflux",
    version: APP_VERSION,
  });

  server.tool(
    "register_session",
    "Register or update this external terminal session as an Agent Thread under its project directory.",
    {
      name: z.string().min(1).max(120),
      project_dir: z.string().optional(),
      runtime: z.enum(["claude", "codex", "antigravity", "acp"]).optional(),
    },
    async (args) => {
      try {
        currentThreadId = ensureMcpThread(db, {
          id: currentThreadId,
          name: args.name,
          project_dir: args.project_dir,
          runtime: args.runtime,
        });
        return ok({ thread: getThread(db, currentThreadId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "list_sessions",
    "List all Agent Threads (both Conflux-managed and external terminal sessions).",
    { project_id: z.number().int().positive().optional() },
    async (args) => {
      try {
        heartbeatThread(db, currentThreadId);
        return ok({ threads: listThreads(db, { project_id: args.project_id }) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "publish_context",
    "Publish a structured shared-memory entry (note/decision/artifact/summary/handoff) for the project or room.",
    {
      title: z.string().min(1).max(300),
      content: z.string().min(1).max(50_000),
      tags: z.array(z.string()).optional(),
      project_id: z.number().int().positive().optional(),
      room_id: z.number().int().positive().optional(),
      kind: z.enum(["note", "decision", "artifact", "summary", "handoff"]).optional(),
      pinned: z.boolean().optional(),
    },
    async (args) => {
      try {
        const me = getThread(db, currentThreadId);
        const entry = publishContext(db, {
          thread_id: currentThreadId,
          project_id: args.project_id ?? me?.project_id ?? null,
          room_id: args.room_id ?? null,
          kind: args.kind as ContextKind | undefined,
          pinned: args.pinned,
          title: args.title,
          content: args.content,
          tags: args.tags,
        });
        return ok({ entry });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "query_context",
    "Search structured shared memory across projects, rooms, or threads.",
    {
      query: z.string().optional(),
      project_id: z.number().int().positive().optional(),
      room_id: z.number().int().positive().optional(),
      kind: z.enum(["note", "decision", "artifact", "summary", "handoff"]).optional(),
      pinned: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      try {
        heartbeatThread(db, currentThreadId);
        return ok({ entries: queryContext(db, args) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "ask_session",
    "Ask another Agent Thread a question (subject to autonomous hop/cooldown guardrails).",
    {
      to_session: z.string().min(1),
      question: z.string().min(1),
      room_id: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const res = await askThread(db, {
          from_thread: currentThreadId,
          to_thread: args.to_session,
          question: args.question,
          room_id: args.room_id ?? null,
        });
        return ok(res);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "check_inbox",
    "Read pending cross-agent messages addressed to this thread.",
    {},
    async () => {
      try {
        return ok({ messages: checkInbox(db, currentThreadId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "reply_ask",
    "Reply to a pending message addressed to this thread and auto-advance any linked workflow step.",
    {
      message_id: z.number().int().positive(),
      reply: z.string().min(1),
    },
    async (args) => {
      try {
        const msg = replyMessage(db, args.message_id, currentThreadId, args.reply);
        await onWorkflowStepMessageCompleted(db, args.message_id, { ok: true, output: args.reply });
        return ok({ message: msg });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "room_summon",
    "Summon an Agent Thread inside a collaboration room.",
    {
      room_id: z.number().int().positive(),
      executor_thread_id: z.string().min(1),
      prompt: z.string().min(1),
    },
    async (args) => {
      try {
        const res = await summonRoomAgent(db, {
          room_id: args.room_id,
          executor_thread_id: args.executor_thread_id,
          prompt: args.prompt,
          initiator_thread_id: currentThreadId,
        });
        return ok(res);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "room_report_done",
    "Report completion summary for a room task.",
    {
      task_id: z.number().int().positive(),
      summary: z.string().min(1),
      status: z.enum(["done", "failed"]).optional(),
    },
    async (args) => {
      try {
        const task = reportRoomTaskDone(db, args.task_id, args.summary, args.status ?? "done");
        if (!task) return fail(new Error("room task not found"));
        return ok({ task });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "handoff_context",
    "Package summary + pinned shared memories and hand off work to another Agent Thread.",
    {
      to_thread: z.string().min(1),
      title: z.string().optional(),
      note: z.string().optional(),
      prompt: z.string().optional(),
      room_id: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const res = await handoffContext(db, {
          from_thread: currentThreadId,
          to_thread: args.to_thread,
          title: args.title,
          note: args.note,
          prompt: args.prompt,
          room_id: args.room_id ?? null,
        });
        return ok(res);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "workflow_create",
    "Create a multi-agent DAG workflow with cycle validation.",
    {
      name: z.string().min(1),
      description: z.string().optional(),
      project_id: z.number().int().positive().optional(),
      room_id: z.number().int().positive().optional(),
      steps: z.array(
        z.object({
          key: z.string().min(1),
          title: z.string().min(1),
          kind: z.enum(["agent", "human_gate"]),
          depends_on: z.array(z.string()),
          target_thread_id: z.string().nullable().optional(),
          prompt_template: z.string(),
          include_handoff: z.boolean().optional(),
        }),
      ),
    },
    async (args) => {
      try {
        const wf = createWorkflow(db, {
          name: args.name,
          description: args.description,
          project_id: args.project_id ?? null,
          room_id: args.room_id ?? null,
          steps: args.steps as WorkflowStepDefinition[],
        });
        return ok({ workflow: wf });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "workflow_start",
    "Start a DAG workflow run.",
    {
      workflow_id: z.number().int().positive(),
      input: z.string().optional(),
    },
    async (args) => {
      try {
        const run = await startWorkflowRun(db, args.workflow_id, {
          input: args.input,
          initiated_by: currentThreadId,
        });
        return ok({ run });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "workflow_status",
    "Inspect a DAG workflow run and all step statuses/outputs.",
    { run_id: z.number().int().positive() },
    async (args) => {
      try {
        const run = getWorkflowRun(db, args.run_id);
        if (!run) return fail(new Error("workflow run not found"));
        return ok({ run });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

export async function startMcpServer(opts: { scope?: Scope; overrideDataDir?: string } = {}): Promise<void> {
  const config = resolveConfig(opts.scope ?? "global", opts.overrideDataDir);
  const db = openDb(config);
  const threadId = ensureMcpThread(db);
  const server = createMcpServer(db, threadId);
  const transport = new StdioServerTransport();

  const beat = setInterval(() => {
    try {
      if (db.open) heartbeatThread(db, threadId);
    } catch {
      // ignore transient lock
    }
  }, 30_000);
  beat.unref();

  const cleanup = () => {
    clearInterval(beat);
    stopWalCheckpoint(db);
    if (db.open) db.close();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  logger.info({ threadId, dbPath: config.dbPath }, "conflux v2 mcp server starting on stdio");
  await server.connect(transport);
}
