import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { IncomingCallMode, RuntimeId } from "@conflux/shared";
import { resolveConfig, type Scope } from "../config.js";
import { APP_VERSION } from "../version.js";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { ensureProjectForDir } from "../core/projects.js";
import {
  getThread,
  heartbeatThread,
  insertThread,
  isValidIncomingCallMode,
  isValidRuntime,
  listThreads,
  updateThread,
} from "../core/threads/store.js";
import { isThreadCurrentlyLive } from "../core/graph.js";
import {
  askThread,
  checkInbox,
  replyMessage,
  waitForMessageOutcome,
} from "../core/messages.js";
import { onWorkflowStepMessageCompleted } from "../core/workflows.js";
import { publishLiveEvent } from "../core/event-bus.js";
import { resolveMicaExecutable } from "../core/runtime-env.js";
import {
  createDefaultMicaRunner,
  createMicaClient,
  MicaCliError,
} from "../core/mica/client.js";
import { parseMicaPaneId } from "../core/mica/pane-id.js";
import { getMicaBridge, unbindMicaPane } from "../core/mica/watcher.js";
import { logger } from "../log.js";

const LOCAL_HOST = hostname() || "localhost";

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

function dirLeaf(dirPath: string): string {
  const cleaned = dirPath.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || basename(cleaned) || "workspace";
}

/**
 * Ensure an external MCP caller (local stdio or remote Streamable HTTP over LAN/Tailscale)
 * is mapped 1:1 to `agent_threads` by its real `session_id` + `cwd` + `host`.
 */
export function ensureMcpThread(
  db: DB,
  opts: {
    id?: string;
    name?: string;
    project_dir?: string;
    host?: string;
    runtime?: RuntimeId;
    external_session_id?: string;
    incoming_call_mode?: IncomingCallMode;
    mica_pane_id?: number | null;
  } = {},
): string {
  const externalSessionId =
    opts.external_session_id?.trim() ||
    process.env.CONFLUX_EXTERNAL_SESSION_ID?.trim() ||
    opts.id?.trim() ||
    null;

  const id =
    opts.id?.trim() ||
    process.env.CONFLUX_THREAD_ID?.trim() ||
    process.env.CONFLUX_SESSION_ID?.trim() ||
    `ext-${randomUUID().slice(0, 12)}`;

  const existing = getThread(db, id);
  const host = opts.host?.trim() || existing?.host || process.env.CONFLUX_HOST_NAME?.trim() || LOCAL_HOST;
  const isRemoteHost = host.toLowerCase() !== LOCAL_HOST.toLowerCase();
  const rawDir = opts.project_dir?.trim() || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workdir = isRemoteHost ? rawDir : resolve(rawDir);
  const project = isRemoteHost ? null : ensureProjectForDir(db, workdir);
  // Pane IDs address the Mica instance on this machine. Only stdio callers
  // that omit the option may inherit their own shell's environment.
  const paneId = isRemoteHost
    ? null
    : parseMicaPaneId(
        opts.mica_pane_id === undefined
          ? process.env.MICA_PANE_ID ?? process.env.mica_pane_id
          : opts.mica_pane_id,
      );

  if (existing) {
    heartbeatThread(db, existing.id);
    const patch: Parameters<typeof updateThread>[2] = {
      ...(existing.state === "stopped" ? { state: "idle" } : {}),
      ...(paneId !== null && paneId !== existing.mica_pane_id ? { mica_pane_id: paneId } : {}),
      ...(host && host !== existing.host ? { host } : {}),
      ...(opts.project_dir?.trim() && workdir !== existing.workdir ? { workdir } : {}),
      ...(project?.id && existing.project_id !== project.id ? { project_id: project.id } : {}),
      ...(externalSessionId && !existing.external_session_id
        ? { external_session_id: externalSessionId }
        : {}),
      ...(opts.name?.trim() && opts.name.trim() !== existing.name && existing.kind === "external"
        ? { name: opts.name.trim() }
        : {}),
      ...(opts.incoming_call_mode && isValidIncomingCallMode(opts.incoming_call_mode)
        ? { incoming_call_mode: opts.incoming_call_mode }
        : {}),
    };
    const updated = Object.keys(patch).length > 0 ? updateThread(db, existing.id, patch) : existing;
    if (updated) {
      if (patch.mica_pane_id !== undefined) getMicaBridge()?.notifyBindingChanged();
      publishLiveEvent({
        type: "thread.updated",
        project_id: updated.project_id,
        thread_id: updated.id,
        payload: { action: "heartbeat", thread: updated },
      });
    }
    return existing.id;
  }

  const runtime = opts.runtime && isValidRuntime(opts.runtime) ? opts.runtime : detectExternalRuntime();
  const name = opts.name?.trim() || `${runtime}-${dirLeaf(workdir)}`;
  const created = insertThread(db, {
    id,
    project_id: project?.id ?? null,
    name,
    kind: "external",
    runtime,
    state: "idle",
    approval_mode: "ask",
    incoming_call_mode: opts.incoming_call_mode ?? "auto",
    host,
    workdir,
    external_session_id: externalSessionId ?? id,
    pid: isRemoteHost ? null : process.ppid || null,
    mica_pane_id: paneId,
  });
  if (created.mica_pane_id != null) getMicaBridge()?.notifyBindingChanged();
  publishLiveEvent({
    type: "thread.updated",
    project_id: created.project_id,
    thread_id: created.id,
    payload: { action: "registered", thread: created },
  });
  return id;
}

function resolvePeerTarget(db: DB, rawTarget: string): string {
  const key = rawTarget.trim();
  const direct = getThread(db, key);
  if (direct) return direct.id;

  const all = listThreads(db);
  const byExtId = all.find((t) => t.external_session_id === key);
  if (byExtId) return byExtId.id;

  const lower = key.toLowerCase();
  const byName = all.filter((t) => t.name.toLowerCase() === lower && isThreadCurrentlyLive(t));
  if (byName.length === 1) return byName[0].id;
  const anyByName = all.filter((t) => t.name.toLowerCase() === lower);
  if (anyByName.length === 1) return anyByName[0].id;

  return key;
}

export function createMcpServer(
  db: DB,
  defaultThreadId?: string,
  peerMeta: {
    host?: string;
    project_dir?: string;
    runtime?: RuntimeId;
    name?: string;
    allowMicaEnv?: boolean;
  } = {},
): McpServer {
  let currentThreadId =
    defaultThreadId ||
    ensureMcpThread(db, {
      host: peerMeta.host,
      project_dir: peerMeta.project_dir,
      runtime: peerMeta.runtime,
      name: peerMeta.name,
      mica_pane_id: peerMeta.allowMicaEnv === false ? null : undefined,
    });

  const server = new McpServer({
    name: "conflux",
    version: APP_VERSION,
  });

  // ---- 4 Golden Inter-Agent Mesh Tools ----

  server.tool(
    "list_peers",
    "List currently online peer Agents across local and LAN/Tailscale machines (strict 1:1 session_id + cwd + host).",
    {
      include_offline: z.boolean().optional(),
      host: z.string().optional(),
    },
    async (args) => {
      try {
        heartbeatThread(db, currentThreadId);
        const nowMs = Date.now();
        let peers = listThreads(db).map((t) => ({
          id: t.id,
          name: t.name,
          host: t.host,
          workdir: t.workdir,
          runtime: t.runtime,
          kind: t.kind,
          state: t.state,
          incoming_call_mode: t.incoming_call_mode,
          external_session_id: t.external_session_id ?? null,
          mica_pane_id: t.mica_pane_id ?? null,
          live: isThreadCurrentlyLive(t, nowMs),
          is_self: t.id === currentThreadId,
        }));
        if (!args.include_offline) {
          peers = peers.filter((p) => p.live);
        }
        if (args.host?.trim()) {
          const targetHost = args.host.trim().toLowerCase();
          peers = peers.filter((p) => p.host.toLowerCase() === targetHost);
        }
        return ok({ self_id: currentThreadId, peers });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "ask_peer",
    "Ask another online peer Agent a question, optionally attaching code/diff context and waiting synchronously for a reply.",
    {
      to: z.string().min(1).describe("Target peer id, external_session_id, or unique name"),
      question: z.string().min(1).describe("Concise question or request for the peer"),
      context: z
        .string()
        .max(40_000)
        .optional()
        .describe("Optional code snippet or git diff for cross-machine peers"),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(60)
        .optional()
        .describe("Optional seconds to wait synchronously for reply_peer (0 = fire-and-forget)"),
    },
    async (args) => {
      try {
        const targetId = resolvePeerTarget(db, args.to);
        const res = await askThread(db, {
          from_thread: currentThreadId,
          to_thread: targetId,
          question: args.question,
          context: args.context ?? null,
        });
        if (args.wait_seconds && args.wait_seconds > 0) {
          const outcome = await waitForMessageOutcome(db, res.message.id, args.wait_seconds);
          return ok({
            ...res,
            message: outcome.message,
            reply: outcome.message.reply,
            timed_out: outcome.timed_out,
          });
        }
        return ok(res);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "check_inbox",
    "Heartbeat this peer and read pending incoming questions addressed to it (including any attached diff context).",
    {},
    async () => {
      try {
        return ok({ self_id: currentThreadId, messages: checkInbox(db, currentThreadId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "reply_peer",
    "Reply to a pending message addressed to this peer, waking any caller waiting on ask_peer.",
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

  // Optional identity helper for remote sessions to declare explicit name / cwd / host / incoming policy
  server.tool(
    "register_peer",
    "Declare or update this peer's display name, original working directory, hostname, and incoming-call policy.",
    {
      name: z.string().min(1).max(120),
      cwd: z.string().optional(),
      host: z.string().optional(),
      runtime: z.enum(["claude", "codex", "antigravity", "acp"]).optional(),
      session_id: z.string().optional(),
      incoming_call_mode: z.enum(["auto", "ask", "dnd"]).optional(),
    },
    async (args) => {
      try {
        currentThreadId = ensureMcpThread(db, {
          id: args.session_id?.trim() || currentThreadId,
          name: args.name,
          project_dir: args.cwd,
          host: args.host ?? getThread(db, currentThreadId)?.host,
          runtime: args.runtime,
          external_session_id: args.session_id,
          incoming_call_mode: args.incoming_call_mode,
          mica_pane_id: peerMeta.allowMicaEnv === false ? null : undefined,
        });
        return ok({ peer: getThread(db, currentThreadId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // Read-only thin adapter over the core Mica bridge so agents can inspect
  // terminal output without stealing focus or altering scrollback state.
  server.tool(
    "read_mica_snapshot",
    "Read a side-effect-free plain-text snapshot (screen and optional scrollback) from a bound Mica terminal pane.",
    {
      thread_id: z
        .string()
        .min(1)
        .optional()
        .describe("Target thread id, external_session_id, or unique peer name (defaults to caller thread)"),
      pane_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Explicit Mica pane_id (overrides thread_id lookup when provided)"),
      scrollback: z
        .boolean()
        .optional()
        .describe("Include scrollback history above the visible viewport (default: true)"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum physical lines to return from the tail (default: 80)"),
    },
    async (args) => {
      try {
        heartbeatThread(db, currentThreadId);
        let paneId: number;
        let resolvedThreadId: string | null = null;
        if (args.pane_id != null) {
          paneId = args.pane_id;
        } else {
          const targetId = args.thread_id ? resolvePeerTarget(db, args.thread_id) : currentThreadId;
          const thread = getThread(db, targetId);
          if (!thread) {
            throw new Error(`thread not found: ${args.thread_id ?? currentThreadId}`);
          }
          if (thread.mica_pane_id == null) {
            throw new Error(`thread "${thread.name}" is not bound to a Mica pane`);
          }
          paneId = thread.mica_pane_id;
          resolvedThreadId = thread.id;
        }

        const micaClient =
          getMicaBridge()?.client() ??
          createMicaClient(createDefaultMicaRunner(resolveMicaExecutable(db)));
        try {
          const snapshot = await micaClient.read(paneId, {
            scrollback: args.scrollback ?? true,
            lines: args.lines ?? 80,
          });
          return ok({ thread_id: resolvedThreadId, ...snapshot });
        } catch (err) {
          if (err instanceof MicaCliError && err.code === "bad_target") {
            unbindMicaPane(db, paneId, "mcp_read_bad_target");
            getMicaBridge()?.notifyBindingChanged();
            throw new Error(
              `Mica pane #${paneId} is closed or no longer exists; stale binding cleared`,
              { cause: err },
            );
          }
          throw err;
        }
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
    try {
      if (db.open) {
        updateThread(db, threadId, { state: "stopped" });
      }
    } catch {
      // ignore on exit
    }
    stopWalCheckpoint(db);
    if (db.open) db.close();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  logger.info({ threadId, dbPath: config.dbPath }, "conflux mcp mesh server starting on stdio");
  await server.connect(transport);
}
