import type { DB } from "./db.js";
import type { ContextEntry } from "./context.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../config.js";

interface ContextRow {
  id: number;
  session_id: string;
  title: string;
  content: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: ContextRow): ContextEntry {
  return {
    ...row,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
  };
}

export interface QueryInput {
  session_id?: string;
  query?: string;
  tags?: string[];
  limit?: number;
}

/**
 * FTS5 query with manual tag filtering.
 * An empty query returns the most recently updated entries (useful for browsing).
 */
export function queryContext(db: DB, input: QueryInput): ContextEntry[] {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const tags = input.tags && input.tags.length > 0 ? input.tags : null;

  // No FTS query and no tag filter: simple recent-list.
  if (!input.query && !tags) {
    const where = input.session_id ? `WHERE session_id = ?` : "";
    const params: (string | number)[] = input.session_id ? [input.session_id] : [];
    const rows = db
      .prepare(
        `SELECT * FROM context_entries ${where} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...params, limit) as ContextRow[];
    return rows.map(toEntry);
  }

  // Compose a query that combines FTS rank + post-filter tags/session.
  let ftsSql = "";
  const ftsParams: string[] = [];
  if (input.query && input.query.trim().length > 0) {
    ftsSql = `
      JOIN context_fts fts ON context_entries.id = fts.rowid
      WHERE context_fts MATCH ?
    `;
    ftsParams.push(toFtsQuery(input.query));
  } else {
    ftsSql = "WHERE 1=1";
  }

  if (input.session_id) {
    ftsSql += input.query ? ` AND context_entries.session_id = ?` : ` AND context_entries.session_id = ?`;
    ftsParams.push(input.session_id);
  }

  const order = input.query
    ? `ORDER BY rank`
    : `ORDER BY context_entries.updated_at DESC`;

  // We fetch a larger candidate set then filter tags in JS (tags stored as JSON).
  const fetchLimit = Math.min(limit * 4, MAX_LIMIT);
  const candidateRows = db
    .prepare(
      `SELECT context_entries.* FROM context_entries ${ftsSql} ${order} LIMIT ?`
    )
    .all(...ftsParams, fetchLimit) as ContextRow[];

  const out: ContextEntry[] = [];
  for (const row of candidateRows) {
    if (out.length >= limit) break;
    if (tags) {
      const rowTags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
      if (!tags.some((t) => rowTags.includes(t))) continue;
    }
    out.push(toEntry(row));
  }
  return out;
}

/**
 * Build an FTS5 query string. We treat the user input as a list of prefix
 * terms connected by AND, with each term wrapped in quotes so special chars
 * (e.g. parentheses) don't break the parser.
 */
function toFtsQuery(raw: string): string {
  const cleaned = raw.replace(/["*]/g, " ").trim();
  if (cleaned.length === 0) return '""';
  const terms = cleaned.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"*`).join(" ");
}
