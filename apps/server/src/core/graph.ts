import { WEB_CONSOLE_ID, WEB_CONSOLE_NAME, type Graph, type GraphEdge, type GraphNode } from "@conflux/shared";
import type { DB } from "./db.js";
import { listThreads } from "./threads/store.js";

export function buildGraph(db: DB): Graph {
  const threads = listThreads(db);
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
    project_id: t.project_id,
    project_name: t.project_name ?? null,
    workdir: t.workdir,
    worktree_branch: t.worktree_branch,
    pending_approvals: t.pending_approvals ?? 0,
    context_count: ctxCounts.get(t.id) ?? 0,
    room_ids: t.room_ids ?? [],
  }));

  const rawEdges = db
    .prepare(
      `SELECT e.rowid AS id, e.from_thread AS "from", e.to_thread AS "to",
              e.weight, e.last_interact_at,
              (SELECT question FROM messages m
               WHERE m.from_thread = e.from_thread AND m.to_thread = e.to_thread
               ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM edges e
       ORDER BY e.last_interact_at DESC`,
    )
    .all() as GraphEdge[];

  const knownIds = new Set(nodes.map((n) => n.id));
  // Include web-console pseudo-node only when it participates in edges.
  if (rawEdges.some((e) => e.from === WEB_CONSOLE_ID || e.to === WEB_CONSOLE_ID)) {
    nodes.unshift({
      id: WEB_CONSOLE_ID,
      name: WEB_CONSOLE_NAME,
      kind: "console",
      runtime: "web",
      state: "idle",
      project_id: null,
      project_name: null,
      workdir: null,
      worktree_branch: null,
      pending_approvals: 0,
      context_count: ctxCounts.get(WEB_CONSOLE_ID) ?? 0,
      room_ids: [],
    });
    knownIds.add(WEB_CONSOLE_ID);
  }

  const edges = rawEdges.filter((e) => knownIds.has(e.from) && knownIds.has(e.to));
  return { nodes, edges };
}
