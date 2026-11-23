import type { DB } from "./db.js";
import { normalizeContextKind, type ContextEntry, type ContextKind } from "./context.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../config.js";

interface ContextRow {
  id: number;
  session_id: string;
  title: string;
  content: string;
  tags: string | null;
  room_id?: number | null;
  kind?: string | null;
  pinned?: number | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: ContextRow): ContextEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    title: row.title,
    content: row.content,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
    room_id: row.room_id ?? null,
    kind: normalizeContextKind(row.kind),
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface QueryInput {
  session_id?: string;
  room_id?: number;
  kind?: ContextKind;
  pinned?: boolean;
  query?: string;
  tags?: string[];
  limit?: number;
}

/**
 * FTS5 query with structured memory filters (room_id, kind, pinned, tags).
 * An empty query returns the most recently updated entries (pinned first).
 */
export function queryContext(db: DB, input: QueryInput): ContextEntry[] {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const tags = input.tags && input.tags.length > 0 ? input.tags : null;
  const ftsQuery = input.query ? toFtsQuery(input.query) : null;

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (ftsQuery) {
    clauses.push("context_fts MATCH ?");
    params.push(ftsQuery);
  }
  if (input.session_id) {
    clauses.push("context_entries.session_id = ?");
    params.push(input.session_id);
  }
  if (input.room_id !== undefined) {
    clauses.push("context_entries.room_id = ?");
    params.push(input.room_id);
  }
  if (input.kind) {
    clauses.push("context_entries.kind = ?");
    params.push(input.kind);
  }
  if (input.pinned !== undefined) {
    clauses.push("context_entries.pinned = ?");
    params.push(input.pinned ? 1 : 0);
  }

  const joinSql = ftsQuery ? "JOIN context_fts fts ON context_entries.id = fts.rowid" : "";
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderSql = ftsQuery
    ? "ORDER BY context_entries.pinned DESC, rank"
    : "ORDER BY context_entries.pinned DESC, context_entries.updated_at DESC";

  const fetchLimit = tags ? Math.min(limit * 4, MAX_LIMIT) : limit;
  const candidateRows = db
    .prepare(`SELECT context_entries.* FROM context_entries ${joinSql} ${whereSql} ${orderSql} LIMIT ?`)
    .all(...params, fetchLimit) as ContextRow[];

  const out: ContextEntry[] = [];
  for (const row of candidateRows) {
    if (out.length >= limit) break;
    const entry = toEntry(row);
    if (tags) {
      const rowTags = entry.tags ?? [];
      if (!tags.some((t) => rowTags.includes(t))) continue;
    }
    out.push(entry);
  }
  return out;
}

function toFtsQuery(raw: string): string | null {
  const cleaned = raw.replace(/["*]/g, " ").trim();
  if (cleaned.length === 0) return null;
  const terms = cleaned.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}
