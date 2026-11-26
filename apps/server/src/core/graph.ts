import {
  WEB_CONSOLE_ID,
  WEB_CONSOLE_NAME,
  type AgentThread,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type MessageStatus,
} from "@conflux/shared";
import { hostname } from "node:os";
import type { DB } from "./db.js";
import { listThreads } from "./threads/store.js";
import { getThreadManager } from "./threads/executor.js";

const DEFAULT_EXTERNAL_LIVE_TTL_MS = 120_000;
const LOCAL_HOST = hostname() || "localhost";

export function isThreadCurrentlyLive(thread: AgentThread, nowMs = Date.now()): boolean {
  if (thread.state === "stopped") return false;
  if (thread.kind === "managed") {
    const manager = getThreadManager();
    if (manager) {
      return manager.isLive(thread.id) || thread.state === "running" || thread.state === "waiting_approval";
    }
    return true;
  }
  const ttlMs = Number(process.env.CONFLUX_PEER_TTL_MS || DEFAULT_EXTERNAL_LIVE_TTL_MS);
  const lastSeen = Date.parse(thread.last_seen_at);
  if (!Number.isFinite(lastSeen)) return true;
  return nowMs - lastSeen <= ttlMs;
}

interface RawGraphEdgeRow {
  id: number;
  from: string;
  to: string;
  weight: number;
  last_interact_at: string;
  last_message: string | null;
  last_message_id: number | null;
  last_status: string | null;
  trace_id: string | null;
  hop_count: number | null;
}

export function buildGraph(db: DB, opts: { includeOffline?: boolean } = {}): Graph {
  const manager = getThreadManager();
  const allThreads = manager ? manager.listDecoratedThreads() : listThreads(db);
  const nowMs = Date.now();
  const threads = opts.includeOffline
    ? allThreads
    : allThreads.filter((t) => isThreadCurrentlyLive(t, nowMs));

  const ctxCounts = new Map<string, number>();
  for (const row of db
    .prepare(`SELECT thread_id, COUNT(*) AS n FROM context_entries GROUP BY thread_id`)
    .all() as Array<{ thread_id: string; n: number }>) {
    ctxCounts.set(row.thread_id, row.n);
  }

  const nodes: GraphNode[] = threads.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    runtime: t.runtime,
    state: t.state,
    host: t.host || LOCAL_HOST,
    incoming_call_mode: t.incoming_call_mode ?? "auto",
    external_session_id: t.external_session_id ?? null,
    project_id: t.project_id,
    project_name: t.project_name ?? null,
    workdir: t.workdir,
    worktree_branch: t.worktree_branch,
    pending_approvals: t.pending_approvals ?? 0,
    context_count: ctxCounts.get(t.id) ?? 0,
    room_ids: t.room_ids ?? [],
    live: isThreadCurrentlyLive(t, nowMs),
  }));

  const rawEdges = db
    .prepare(
      `SELECT e.rowid AS id, e.from_thread AS "from", e.to_thread AS "to",
              e.weight, e.last_interact_at,
              (SELECT m.question FROM messages m
               WHERE m.from_thread = e.from_thread AND m.to_thread = e.to_thread
               ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT m.id FROM messages m
               WHERE m.from_thread = e.from_thread AND m.to_thread = e.to_thread
               ORDER BY m.id DESC LIMIT 1) AS last_message_id,
              (SELECT m.status FROM messages m
               WHERE m.from_thread = e.from_thread AND m.to_thread = e.to_thread
               ORDER BY m.id DESC LIMIT 1) AS last_status,
              (SELECT m.trace_id FROM messages m
               WHERE m.from_thread = e.from_thread AND m.to_thread = e.to_thread
               ORDER BY m.id DESC LIMIT 1) AS trace_id,
              (SELECT m.hop_count FROM messages m
               WHERE m.from_thread = e.from_thread AND m.to_thread = e.to_thread
               ORDER BY m.id DESC LIMIT 1) AS hop_count
       FROM edges e
       ORDER BY e.last_interact_at DESC`,
    )
    .all() as RawGraphEdgeRow[];

  const knownIds = new Set(nodes.map((n) => n.id));
  if (
    rawEdges.some(
      (e) =>
        (e.from === WEB_CONSOLE_ID && knownIds.has(e.to)) ||
        (e.to === WEB_CONSOLE_ID && knownIds.has(e.from)),
    )
  ) {
    nodes.unshift({
      id: WEB_CONSOLE_ID,
      name: WEB_CONSOLE_NAME,
      kind: "console",
      runtime: "web",
      state: "idle",
      host: LOCAL_HOST,
      incoming_call_mode: "auto",
      external_session_id: null,
      project_id: null,
      project_name: null,
      workdir: null,
      worktree_branch: null,
      pending_approvals: 0,
      context_count: ctxCounts.get(WEB_CONSOLE_ID) ?? 0,
      room_ids: [],
      live: true,
    });
    knownIds.add(WEB_CONSOLE_ID);
  }

  const edges: GraphEdge[] = rawEdges
    .filter((e) => knownIds.has(e.from) && knownIds.has(e.to))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      weight: e.weight,
      last_interact_at: e.last_interact_at,
      last_message: e.last_message,
      last_message_id: e.last_message_id,
      last_status: (e.last_status as MessageStatus | null) ?? null,
      trace_id: e.trace_id,
      hop_count: e.hop_count ?? 0,
    }));

  return { nodes, edges };
}
