import type { DB } from "../db.js";
import { nowIso } from "../db.js";

/**
 * Approval bookkeeping for the managed Codex executor. A server-initiated
 * approval request is persisted (sanitized) with the identity of the run it
 * paused; user decisions flip it exactly once and only while the request is
 * still pending AND still owned by the live generation that received it.
 * Decisions are limited to the per-request actions Conflux actually shows:
 * accept (this once) / decline / cancel — never session-wide or policy
 * amendments, and never auto-approval.
 */

export type ApprovalDecision = "accept" | "decline" | "cancel";
export type ApprovalKind = "commandExecution" | "fileChange";

export interface ApprovalRow {
  id: number;
  run_id: number;
  rpc_request_id: string;
  request_kind: string;
  payload: string;
  state: "pending" | "resolved" | "expired";
  created_at: string;
  resolved_at: string | null;
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "accept" || value === "decline" || value === "cancel";
}

/**
 * Strip an approval request down to what a human needs to decide. Raw
 * policy amendments, environment details and anything unclassified are
 * dropped BEFORE persistence — the payload is replayable display data, not
 * a protocol archive.
 */
export function sanitizeApprovalPayload(
  kind: ApprovalKind,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "commandExecution") {
    return {
      kind: params.kind ?? "command",
      command: typeof params.command === "string" ? params.command : null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
      reason: typeof params.reason === "string" ? params.reason : null,
      itemId: typeof params.itemId === "string" ? params.itemId : null,
    };
  }
  return {
    reason: typeof params.reason === "string" ? params.reason : null,
    grantRoot: typeof params.grantRoot === "string" ? params.grantRoot : null,
    itemId: typeof params.itemId === "string" ? params.itemId : null,
  };
}

export function recordApproval(
  db: DB,
  input: {
    runId: number;
    rpcRequestId: string;
    kind: ApprovalKind;
    payload: Record<string, unknown>;
  },
): ApprovalRow {
  db.prepare(
    `INSERT INTO managed_codex_approvals (run_id, rpc_request_id, request_kind, payload, state, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(input.runId, input.rpcRequestId, input.kind, JSON.stringify(input.payload), nowIso());
  return getApprovalByRpcId(db, input.rpcRequestId)!;
}

export function getApprovalByRpcId(db: DB, rpcRequestId: string | number): ApprovalRow | null {
  const row = db
    .prepare(`SELECT * FROM managed_codex_approvals WHERE rpc_request_id = ?`)
    .get(String(rpcRequestId)) as ApprovalRow | undefined;
  return row ?? null;
}

export function getApproval(db: DB, id: number): ApprovalRow | null {
  const row = db
    .prepare(`SELECT * FROM managed_codex_approvals WHERE id = ?`)
    .get(id) as ApprovalRow | undefined;
  return row ?? null;
}

export function listPendingApprovals(db: DB, runIds: number[]): ApprovalRow[] {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM managed_codex_approvals
       WHERE run_id IN (${placeholders}) AND state = 'pending'
       ORDER BY id ASC`,
    )
    .all(...runIds) as ApprovalRow[];
}

export type ApprovalResolveOutcome =
  | { ok: true; row: ApprovalRow }
  | { ok: false; status: number; reason: string };

/**
 * Resolve a pending approval with the user's decision. The update is
 * conditional on state = pending; anything else (already resolved, expired
 * with a dead connection, unknown id) is a conflict, never a silent second
 * answer to the agent.
 */
export function resolveApproval(
  db: DB,
  input: { approvalId: number; decision: ApprovalDecision },
): ApprovalResolveOutcome {
  const row = getApproval(db, input.approvalId);
  if (!row) return { ok: false, status: 404, reason: "approval not found" };
  if (row.state === "resolved") return { ok: false, status: 409, reason: "approval already resolved" };
  if (row.state === "expired") {
    return { ok: false, status: 409, reason: "approval expired with its connection" };
  }
  const res = db
    .prepare(
      `UPDATE managed_codex_approvals
       SET state = 'resolved', resolved_at = ?
       WHERE id = ? AND state = 'pending'`,
    )
    .run(nowIso(), input.approvalId);
  if (!res.changes) return { ok: false, status: 409, reason: "approval already resolved" };
  return { ok: true, row: getApproval(db, input.approvalId)! };
}

/**
 * Expire every pending approval of these runs — used when the connection
 * generation that received the requests dies. They must stop showing as
 * answerable.
 */
export function expirePendingApprovals(db: DB, runIds: number[]): number {
  if (runIds.length === 0) return 0;
  const placeholders = runIds.map(() => "?").join(",");
  const res = db
    .prepare(
      `UPDATE managed_codex_approvals
       SET state = 'expired', resolved_at = ?
       WHERE run_id IN (${placeholders}) AND state = 'pending'`,
    )
    .run(nowIso(), ...runIds);
  return res.changes;
}
