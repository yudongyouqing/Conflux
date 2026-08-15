import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { markStaleSessions } from "./sessions.js";
import type { Graph, GraphEdge, GraphNode, NodeType } from "@muiltchat/shared";

export type { Graph, GraphEdge, GraphNode, NodeType };

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
  // Hide MCP placeholder nodes (temp:true) that were never adopted by a
  // hook-registered session — they are UUID noise, not real identities.
  const where = status === "all"
    ? `WHERE s.id NOT LIKE 'agent-%' AND COALESCE(s.metadata, '') NOT LIKE '%"temp":true%'`
    : `WHERE s.status = ? AND s.id NOT LIKE 'agent-%' AND COALESCE(s.metadata, '') NOT LIKE '%"temp":true%'`;
  const params: string[] = status === "all" ? [] : [status];

  const nodes = db
    .prepare(
      `SELECT s.id, s.name, s.description, s.project_dir, s.status, s.last_heartbeat_at,
         (SELECT COUNT(*) FROM context_entries c WHERE c.session_id = s.id) AS context_count,
         (SELECT COUNT(*) FROM messages m WHERE m.to_session = s.id AND m.status = 'pending') AS pending_inbox
       FROM sessions s
       ${where}
       ORDER BY s.last_heartbeat_at DESC`
    )
    .all(...params) as (Omit<GraphNode, "type">)[];

  // Also include internal agents as nodes — they are always visible
  // regardless of session heartbeat status.
  const agentNodes = db
    .prepare(
      `SELECT
         'agent-' || a.id AS id,
         a.name,
         'active' AS status,
         a.description,
         (SELECT COUNT(*) FROM context_entries c WHERE c.session_id = 'agent-' || a.id) AS context_count,
         (SELECT COUNT(*) FROM messages m WHERE m.to_session = 'agent-' || a.id AND m.status = 'pending') AS pending_inbox,
         (SELECT COUNT(*) FROM conversations cv WHERE cv.agent_id = a.id) AS conversation_count
       FROM agents a
       ORDER BY a.updated_at DESC`
    )
    .all() as (Omit<GraphNode, "type">)[];

  const edges = db
    .prepare(
      `SELECT from_session AS "from", to_session AS "to", weight, last_interact_at
       FROM edges
       ORDER BY weight DESC, last_interact_at DESC`
    )
    .all() as GraphEdge[];

  return {
    nodes: [
      ...nodes.map((n) => ({ ...n, type: "session" as const })),
      ...agentNodes.map((n) => ({ ...n, type: "agent" as const })),
    ],
    edges,
  };
}
