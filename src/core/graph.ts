import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { markStaleSessions } from "./sessions.js";

export type NodeType = "session"; // "agent" added in slice 1

export interface GraphNode {
  id: string;
  name: string;
  status: string;
  type: NodeType;
  context_count: number;
  pending_inbox: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  last_interact_at: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Upsert a directed edge: increment weight if it exists, create otherwise.
 * Called from askSession (A→B) and replyAsk (B→A).
 */
export function recordEdge(db: DB, from: string, to: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO edges (from_session, to_session, weight, last_interact_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(from_session, to_session) DO UPDATE SET
       weight = edges.weight + 1,
       last_interact_at = excluded.last_interact_at`
  ).run(from, to, now);
}

/**
 * Return the full graph: nodes (sessions) + edges (communication links).
 * Stale sessions are lazily marked before querying.
 */
export function getGraph(
  db: DB,
  opts: { status?: "active" | "stale" | "ended" | "all" } = {}
): Graph {
  markStaleSessions(db);
  const status = opts.status ?? "active";
  const where = status === "all" ? "" : `WHERE s.status = ?`;
  const params: string[] = status === "all" ? [] : [status];

  const nodes = db
    .prepare(
      `SELECT s.id, s.name, s.status,
         (SELECT COUNT(*) FROM context_entries c WHERE c.session_id = s.id) AS context_count,
         (SELECT COUNT(*) FROM messages m WHERE m.to_session = s.id AND m.status = 'pending') AS pending_inbox
       FROM sessions s
       ${where}
       ORDER BY s.last_heartbeat_at DESC`
    )
    .all(...params) as (Omit<GraphNode, "type">)[];

  const edges = db
    .prepare(
      `SELECT from_session AS "from", to_session AS "to", weight, last_interact_at
       FROM edges
       ORDER BY weight DESC, last_interact_at DESC`
    )
    .all() as GraphEdge[];

  return {
    nodes: nodes.map((n) => ({ ...n, type: "session" as const })),
    edges,
  };
}
