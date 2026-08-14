import type { DB } from "./db.js";
import { nowIso } from "./db.js";

export type AuditInterface = "mcp" | "http" | "cli";

export interface AuditEntry {
  id: number;
  ts: string;
  caller_session: string | null;
  interface: AuditInterface;
  action: string;
  args: string | null;
  result: string | null;
}

export interface LogInput {
  caller_session?: string | null;
  interface: AuditInterface;
  action: string;
  args?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}

/**
 * Truncate a JSON-serialised value for the audit table to avoid storing
 * multi-MB payloads if someone publishes a huge context.
 */
const MAX_AUDIT_FIELD = 4 * 1024;

function shrink(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length <= MAX_AUDIT_FIELD) return json;
    return JSON.stringify({
      _truncated: true,
      preview: json.slice(0, MAX_AUDIT_FIELD - 60),
      length: json.length,
    });
  } catch {
    return null;
  }
}

export function logAudit(db: DB, input: LogInput): void {
  db.prepare(
    `INSERT INTO audit_log (ts, caller_session, interface, action, args, result)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    nowIso(),
    input.caller_session ?? null,
    input.interface,
    input.action,
    shrink(input.args),
    shrink(input.result)
  );
}

export function queryAudit(
  db: DB,
  opts: {
    session?: string;
    action?: string;
    iface?: AuditInterface;
    limit?: number;
  } = {}
): AuditEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.session) {
    where.push("caller_session = ?");
    params.push(opts.session);
  }
  if (opts.action) {
    where.push("action = ?");
    params.push(opts.action);
  }
  if (opts.iface) {
    where.push("interface = ?");
    params.push(opts.iface);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as AuditEntry[];
  return rows;
}
