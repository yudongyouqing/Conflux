import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { markStaleSessions } from "./sessions.js";
import type { Graph, GraphEdge, GraphNode, NodeType } from "@muiltchat/shared";
import {
  parseIdentitySource,
  parseRuntimePid,
  parseSessionRuntime,
} from "./session-identity.js";

export type { Graph, GraphEdge, GraphNode, NodeType };

/**
 * Upsert the directed conversation channel (edge) and return its id.
 * Called from askSession only — a reply stays ON the channel it answers
 * (no reverse edge; the channel's last_interact_at is touched instead).
 */
export function recordEdge(db: DB, from: string, to: string): number {
  const now = nowIso();
  db.prepare(
    `INSERT INTO edges (from_session, to_session, weight, last_interact_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(from_session, to_session) DO UPDATE SET
       weight = edges.weight + 1,
       last_interact_at = excluded.last_interact_at`
  ).run(from, to, now);
  const row = db
    .prepare(`SELECT rowid AS id FROM edges WHERE from_session = ? AND to_session = ?`)
    .get(from, to) as { id: number };
  return row.id;
}

/** Touch a channel's activity timestamp without creating traffic (replies). */
export function touchEdge(db: DB, edgeId: number): void {
  db.prepare(`UPDATE edges SET last_interact_at = ? WHERE rowid = ?`).run(nowIso(), edgeId);
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
  // Active MCP placeholders represent live Codex/Claude sessions. Hide only
  // stale or ended placeholders, which are UUID noise after their process exits.
  const tempVisibility = `(COALESCE(s.metadata, '') NOT LIKE '%"temp":true%' OR s.status = 'active')`;
  const where = status === "all"
    ? `WHERE s.id NOT LIKE 'agent-%' AND ${tempVisibility}`
    : `WHERE s.status = ? AND s.id NOT LIKE 'agent-%' AND ${tempVisibility}`;
  const params: string[] = status === "all" ? [] : [status];

  const nodes = db
    .prepare(
      `SELECT s.id, s.name, s.description, s.project_dir, s.status, s.last_heartbeat_at,
         s.metadata, s.runtime, s.identity_source, s.runtime_pid,
         (SELECT COUNT(*) FROM context_entries c WHERE c.session_id = s.id) AS context_count,
         (SELECT COUNT(*) FROM messages m WHERE m.to_session = s.id AND m.status IN ('pending','seen')) AS pending_inbox
       FROM sessions s
       ${where}
       ORDER BY s.last_heartbeat_at DESC`
    )
    .all(...params) as (Omit<GraphNode, "type" | "agent_id" | "skills"> & {
      metadata: string | null;
    })[];

  // Annotate sessions spawned from a runtime-agent preset (metadata carries
  // {agent_id, runtime} — written by hooks/MCP from MUILTCHAT_AGENT_ID).
  // The preset name is a FALLBACK identity for sessions that never got a
  // name of their own (custom title or first prompt excerpt); it must not
  // mask a name the user gave the conversation in Claude Code.
  const presetNames = new Map<number, string>(
    (db.prepare(`SELECT id, name FROM runtime_agents`).all() as { id: number; name: string }[]).map(
      (r) => [r.id, r.name]
    )
  );
  const annotate = (n: (typeof nodes)[number]) => {
    let agentId: number | null = null;
    let runtime = parseSessionRuntime(n.runtime);
    let identitySource = parseIdentitySource(n.identity_source);
    let runtimePid = parseRuntimePid(n.runtime_pid);
    let ownName = false;
    let skills: string[] | undefined;
    try {
      const meta = n.metadata ? (JSON.parse(n.metadata) as Record<string, unknown>) : null;
      if (meta && typeof meta.agent_id === "number") {
        agentId = meta.agent_id;
      }
      if (runtime === null) {
        const legacyClaudePid = parseRuntimePid(meta?.claude_pid);
        runtime = parseSessionRuntime(meta?.runtime) ?? (legacyClaudePid !== null ? "claude" : null);
      }
      if (identitySource === null) identitySource = parseIdentitySource(meta?.identity_source);
      if (runtimePid === null) {
        const legacyClaudePid = parseRuntimePid(meta?.claude_pid);
        const metadataRuntimePid = parseRuntimePid(meta?.runtime_pid);
        runtimePid = metadataRuntimePid ?? (runtime === "claude" ? legacyClaudePid : null);
      }
      ownName = !!(meta && (meta.named === true || meta.custom_title === true));
      // Agent Card: capability self-description written by register_session
      const card = meta?.agent_card;
      if (card && typeof card === "object" && Array.isArray((card as { skills?: unknown }).skills)) {
        skills = ((card as { skills: unknown[] }).skills)
          .filter((s): s is string => typeof s === "string")
          .slice(0, 20);
      }
    } catch {
      // malformed metadata — leave unannotated
    }
    const { metadata, ...rest } = n;
    const name =
      agentId !== null && !ownName ? presetNames.get(agentId) ?? n.name : n.name;
    return {
      ...rest,
      name,
      agent_id: agentId,
      runtime,
      identity_source: identitySource,
      runtime_pid: runtimePid,
      skills,
    };
  };

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
         (SELECT COUNT(*) FROM messages m WHERE m.to_session = 'agent-' || a.id AND m.status IN ('pending','seen')) AS pending_inbox,
         (SELECT COUNT(*) FROM conversations cv WHERE cv.agent_id = a.id) AS conversation_count
       FROM agents a
       ORDER BY a.updated_at DESC`
    )
    .all() as (Omit<GraphNode, "type">)[];

  const edges = db
    .prepare(
      `SELECT e.rowid AS id, e.from_session AS "from", e.to_session AS "to", e.weight, e.last_interact_at,
         COALESCE(
           -- traffic THIS edge's direction carried: its own questions first
           (SELECT m.question FROM messages m
            WHERE m.from_session = e.from_session AND m.to_session = e.to_session
            ORDER BY m.id DESC LIMIT 1),
           -- a reply-only edge (created by reply_ask) shows the answer it carried
           (SELECT '↩ ' || m.reply FROM messages m
            WHERE m.to_session = e.from_session AND m.from_session = e.to_session
              AND m.reply IS NOT NULL
            ORDER BY m.replied_at DESC LIMIT 1)
         ) AS last_message
       FROM edges e
       ORDER BY e.weight DESC, e.last_interact_at DESC`
    )
    .all() as GraphEdge[];

  return {
    nodes: [
      ...nodes.map((n) => ({ ...annotate(n), type: "session" as const })),
      ...agentNodes.map((n) => ({
        ...n,
        agent_id: null,
        runtime: null,
        identity_source: null,
        runtime_pid: null,
        type: "agent" as const,
      })),
    ],
    edges,
  };
}
