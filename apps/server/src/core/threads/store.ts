import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type {
  AgentThread,
  ApprovalDecision,
  ApprovalMode,
  ApprovalState,
  IncomingCallMode,
  ManagedApprovalKind,
  RuntimeId,
  ThreadApproval,
  ThreadCheckpoint,
  ThreadEvent,
  ThreadEventType,
  ThreadKind,
  ThreadRun,
  ThreadRunState,
  ThreadState,
} from "@conflux/shared";
import { nowIso, type DB } from "../db.js";
import { normalizePathKey } from "../git-worktree.js";
import type { ApprovalResponseExtra } from "../managed-codex/approvals.js";

const VALID_RUNTIMES = new Set<RuntimeId>(["claude", "codex", "antigravity", "acp"]);
const LOCAL_HOST = hostname() || "localhost";

export function isValidIncomingCallMode(v: unknown): v is IncomingCallMode {
  return v === "auto" || v === "ask" || v === "dnd";
}

interface ThreadRow {
  id: string;
  project_id: number | null;
  name: string;
  kind: string;
  runtime: string;
  state: string;
  approval_mode: string;
  incoming_call_mode: string | null;
  host: string | null;
  workdir: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_branch: string | null;
  pr_url: string | null;
  preview_url: string | null;
  external_session_id: string | null;
  model: string | null;
  instructions: string | null;
  extra_env: string | null;
  provider_thread_id: string | null;
  owner_token: string | null;
  active_turn_id: string | null;
  pid: number | null;
  mica_pane_id: number | null;
  parent_thread_id: string | null;
  last_synced_context_id: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  project_name?: string | null;
}

interface RunRow {
  id: number;
  thread_id: string;
  message_id: number | null;
  room_id: number | null;
  prompt: string;
  state: string;
  turn_id: string | null;
  final_text: string | null;
  error_code: string | null;
  checkpoint_id: number | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  thread_id: string;
  run_id: number | null;
  type: string;
  payload_json: string;
  created_at: string;
}

interface ApprovalRow {
  id: number;
  thread_id: string;
  run_id: number;
  rpc_request_id: string;
  kind: string;
  payload_json: string;
  state: string;
  decision: string | null;
  response_json: string | null;
  created_at: string;
  resolved_at: string | null;
  thread_name?: string;
  runtime?: string;
  project_id?: number | null;
  room_id?: number | null;
}

interface CheckpointRow {
  id: number;
  thread_id: string;
  run_id: number | null;
  ref_name: string;
  tree_sha: string;
  commit_sha: string;
  summary: string | null;
  created_at: string;
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function isValidRuntime(v: unknown): v is RuntimeId {
  return typeof v === "string" && VALID_RUNTIMES.has(v as RuntimeId);
}

function toThread(db: DB, row: ThreadRow): AgentThread {
  const pendingCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM thread_approvals WHERE thread_id = ? AND state = 'pending'`)
      .get(row.id) as { n: number }
  ).n;
  const roomRows = db
    .prepare(`SELECT room_id FROM room_members WHERE thread_id = ? ORDER BY room_id ASC`)
    .all(row.id) as Array<{ room_id: number }>;

  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    kind: (row.kind === "external" ? "external" : "managed") as ThreadKind,
    runtime: (isValidRuntime(row.runtime) ? row.runtime : "claude") as RuntimeId,
    state: row.state as ThreadState,
    approval_mode: (row.approval_mode === "auto" ? "auto" : "ask") as ApprovalMode,
    incoming_call_mode: isValidIncomingCallMode(row.incoming_call_mode)
      ? row.incoming_call_mode
      : "auto",
    host: row.host?.trim() || LOCAL_HOST,
    workdir: row.workdir,
    worktree_path: row.worktree_path,
    worktree_branch: row.worktree_branch,
    base_branch: row.base_branch,
    pr_url: row.pr_url ?? null,
    preview_url: row.preview_url ?? null,
    external_session_id: row.external_session_id ?? null,
    model: row.model,
    instructions: row.instructions,
    extra_env: row.extra_env,
    provider_thread_id: row.provider_thread_id,
    active_turn_id: row.active_turn_id,
    pid: row.pid,
    mica_pane_id: row.mica_pane_id ?? null,
    parent_thread_id: row.parent_thread_id,
    last_synced_context_id: row.last_synced_context_id ?? 0,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pending_approvals: pendingCount,
    project_name: row.project_name ?? null,
    room_ids: roomRows.map((r) => r.room_id),
  };
}

function toRun(row: RunRow): ThreadRun {
  return {
    id: row.id,
    thread_id: row.thread_id,
    message_id: row.message_id,
    room_id: row.room_id,
    prompt: row.prompt,
    state: row.state as ThreadRunState,
    turn_id: row.turn_id,
    final_text: row.final_text,
    error_code: row.error_code,
    checkpoint_id: row.checkpoint_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toEvent(row: EventRow): ThreadEvent {
  return {
    seq: row.seq,
    thread_id: row.thread_id,
    run_id: row.run_id,
    type: row.type as ThreadEventType,
    payload: safeJsonParse(row.payload_json),
    created_at: row.created_at,
  };
}

function toApproval(row: ApprovalRow): ThreadApproval {
  return {
    id: row.id,
    thread_id: row.thread_id,
    run_id: row.run_id,
    kind: row.kind as ManagedApprovalKind,
    payload: safeJsonParse(row.payload_json),
    state: row.state as ApprovalState,
    decision: (row.decision as ApprovalDecision | null) ?? null,
    response_json: row.response_json,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    ...(row.thread_name !== undefined ? { thread_name: row.thread_name } : {}),
    ...(row.runtime !== undefined ? { runtime: row.runtime as RuntimeId } : {}),
    ...(row.project_id !== undefined ? { project_id: row.project_id } : {}),
    ...(row.room_id !== undefined ? { room_id: row.room_id } : {}),
  };
}

function toCheckpoint(row: CheckpointRow): ThreadCheckpoint {
  return {
    id: row.id,
    thread_id: row.thread_id,
    run_id: row.run_id,
    ref_name: row.ref_name,
    tree_sha: row.tree_sha,
    commit_sha: row.commit_sha,
    summary: row.summary,
    created_at: row.created_at,
  };
}

export function getThread(db: DB, id: string): AgentThread | null {
  const row = db
    .prepare(
      `SELECT t.*, p.name AS project_name
       FROM agent_threads t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`,
    )
    .get(id) as ThreadRow | undefined;
  return row ? toThread(db, row) : null;
}

export function getThreadOwnerToken(db: DB, id: string): string | null {
  const row = db.prepare(`SELECT owner_token FROM agent_threads WHERE id = ?`).get(id) as
    | { owner_token: string | null }
    | undefined;
  return row?.owner_token ?? null;
}

export function listThreads(
  db: DB,
  opts: { project_id?: number; kind?: ThreadKind } = {},
): AgentThread[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.project_id !== undefined) {
    clauses.push("t.project_id = ?");
    params.push(opts.project_id);
  }
  if (opts.kind) {
    clauses.push("t.kind = ?");
    params.push(opts.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT t.*, p.name AS project_name
       FROM agent_threads t
       LEFT JOIN projects p ON p.id = t.project_id
       ${where}
       ORDER BY CASE WHEN t.state IN ('waiting_approval','running','idle') THEN 0 ELSE 1 END, t.updated_at DESC`,
    )
    .all(...params) as ThreadRow[];
  return rows.map((r) => toThread(db, r));
}

export function insertThread(
  db: DB,
  input: {
    id?: string;
    project_id: number | null;
    name: string;
    kind: ThreadKind;
    runtime: RuntimeId;
    state?: ThreadState;
    approval_mode?: ApprovalMode;
    incoming_call_mode?: IncomingCallMode;
    host?: string;
    workdir: string;
    worktree_path?: string | null;
    worktree_branch?: string | null;
    base_branch?: string | null;
    pr_url?: string | null;
    preview_url?: string | null;
    external_session_id?: string | null;
    model?: string | null;
    instructions?: string | null;
    extra_env?: string | null;
    provider_thread_id?: string | null;
    owner_token?: string | null;
    pid?: number | null;
    mica_pane_id?: number | null;
    parent_thread_id?: string | null;
    last_synced_context_id?: number;
  },
): AgentThread {
  const id = input.id ?? randomUUID();
  const now = nowIso();
  const host = input.host?.trim() || LOCAL_HOST;
  const incomingCallMode: IncomingCallMode = isValidIncomingCallMode(input.incoming_call_mode)
    ? input.incoming_call_mode
    : "auto";
  // Preserve remote POSIX paths verbatim instead of resolving them against a local Windows drive.
  const isRemoteHost = host.toLowerCase() !== LOCAL_HOST.toLowerCase();
  const storedWorkdir = isRemoteHost ? input.workdir.trim() : resolve(input.workdir);
  db.prepare(
    `INSERT INTO agent_threads (
       id, project_id, name, kind, runtime, state, approval_mode, incoming_call_mode, host, workdir,
       worktree_path, worktree_branch, base_branch, pr_url, preview_url, external_session_id,
       model, instructions, extra_env,
       provider_thread_id, owner_token, active_turn_id, pid, mica_pane_id, parent_thread_id,
       last_synced_context_id, last_seen_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.name.trim(),
    input.kind,
    input.runtime,
    input.state ?? "idle",
    input.approval_mode ?? "ask",
    incomingCallMode,
    host,
    storedWorkdir,
    input.worktree_path ?? null,
    input.worktree_branch ?? null,
    input.base_branch ?? null,
    input.pr_url ?? null,
    input.preview_url ?? null,
    input.external_session_id ?? null,
    input.model?.trim() || null,
    input.instructions?.trim() || null,
    input.extra_env?.trim() || null,
    input.provider_thread_id ?? null,
    input.owner_token ?? null,
    input.pid ?? null,
    input.mica_pane_id ?? null,
    input.parent_thread_id ?? null,
    input.last_synced_context_id ?? 0,
    now,
    now,
    now,
  );
  return getThread(db, id)!;
}

export function updateThread(
  db: DB,
  id: string,
  patch: Partial<{
    project_id: number | null;
    name: string;
    state: ThreadState;
    approval_mode: ApprovalMode;
    incoming_call_mode: IncomingCallMode;
    host: string;
    workdir: string;
    worktree_path: string | null;
    worktree_branch: string | null;
    base_branch: string | null;
    pr_url: string | null;
    preview_url: string | null;
    external_session_id: string | null;
    model: string | null;
    instructions: string | null;
    provider_thread_id: string | null;
    owner_token: string | null;
    active_turn_id: string | null;
    pid: number | null;
    mica_pane_id: number | null;
    last_synced_context_id: number;
    last_seen_at: string;
  }>,
): AgentThread | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(val);
  }
  if (sets.length === 0) return getThread(db, id);
  sets.push("updated_at = ?");
  params.push(nowIso(), id);
  db.prepare(`UPDATE agent_threads SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getThread(db, id);
}

export function heartbeatThread(db: DB, id: string): void {
  const now = nowIso();
  db.prepare(`UPDATE agent_threads SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(
    now,
    now,
    id,
  );
}

export function listThreadsByMicaPane(db: DB, paneId: number): AgentThread[] {
  const rows = db
    .prepare(
      `SELECT t.*, p.name AS project_name
       FROM agent_threads t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.mica_pane_id = ?`,
    )
    .all(paneId) as ThreadRow[];
  return rows.map((r) => toThread(db, r));
}

export function listMicaBoundThreads(db: DB): AgentThread[] {
  const rows = db
    .prepare(
      `SELECT t.*, p.name AS project_name
       FROM agent_threads t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.mica_pane_id IS NOT NULL`,
    )
    .all() as ThreadRow[];
  return rows.map((r) => toThread(db, r));
}

export function deleteThreadRow(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM agent_threads WHERE id = ?`).run(id).changes > 0;
}

/**
 * Single-writer directory lock: when a managed thread does NOT use its own isolated
 * worktree, strictly refuse launching or activating a second live managed writer
 * targeting the exact same working directory.
 */
export function findConflictingDirectoryWriter(
  db: DB,
  workdir: string,
  opts: { excludeThreadId?: string; liveThreadIds?: ReadonlySet<string> } = {},
): AgentThread | null {
  const targetKey = normalizePathKey(workdir);
  const rows = db
    .prepare(
      `SELECT t.*, p.name AS project_name
       FROM agent_threads t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.kind = 'managed' AND t.state IN ('idle', 'running', 'waiting_approval')`,
    )
    .all() as ThreadRow[];

  for (const row of rows) {
    if (opts.excludeThreadId && row.id === opts.excludeThreadId) continue;
    if (normalizePathKey(row.workdir) !== targetKey) continue;
    // If liveThreadIds is provided, check whether it's actually held live or actively running in DB.
    if (opts.liveThreadIds && !opts.liveThreadIds.has(row.id) && row.state === "idle") {
      continue;
    }
    return toThread(db, row);
  }
  return null;
}

export function assertDirectoryWritable(
  db: DB,
  workdir: string,
  opts: { excludeThreadId?: string; liveThreadIds?: ReadonlySet<string> } = {},
): void {
  const conflict = findConflictingDirectoryWriter(db, workdir, opts);
  if (conflict) {
    throw Object.assign(
      new Error(
        `目录写锁冲突：Agent「${conflict.name}」正在持有目录 ${workdir} 的写入权。同一目录不允许多个 Agent 并发写入，请先停止该 Agent 或勾选「独立 Worktree」隔离工作区。`,
      ),
      { statusCode: 409 },
    );
  }
}

// ---- Runs ----

export function createThreadRun(
  db: DB,
  input: {
    threadId: string;
    prompt: string;
    messageId?: number | null;
    roomId?: number | null;
  },
): ThreadRun {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO thread_runs (thread_id, message_id, room_id, prompt, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(input.threadId, input.messageId ?? null, input.roomId ?? null, input.prompt, now, now);
  return getThreadRun(db, Number(res.lastInsertRowid))!;
}

export function getThreadRun(db: DB, runId: number): ThreadRun | null {
  const row = db.prepare(`SELECT * FROM thread_runs WHERE id = ?`).get(runId) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function listThreadRuns(db: DB, threadId: string, limit = 30): ThreadRun[] {
  const rows = db
    .prepare(`SELECT * FROM thread_runs WHERE thread_id = ? ORDER BY id DESC LIMIT ?`)
    .all(threadId, Math.max(1, Math.min(limit, 200))) as RunRow[];
  return rows.map(toRun);
}

export function claimNextQueuedRun(db: DB, threadId: string): ThreadRun | null {
  return db
    .transaction(() => {
      const inFlight = db
        .prepare(
          `SELECT id FROM thread_runs
           WHERE thread_id = ? AND state IN ('submitting','running','waiting_approval')
           LIMIT 1`,
        )
        .get(threadId);
      if (inFlight) return null;
      const next = db
        .prepare(
          `SELECT * FROM thread_runs
           WHERE thread_id = ? AND state = 'queued'
           ORDER BY id ASC LIMIT 1`,
        )
        .get(threadId) as RunRow | undefined;
      if (!next) return null;
      db.prepare(`UPDATE thread_runs SET state = 'submitting', updated_at = ? WHERE id = ?`).run(
        nowIso(),
        next.id,
      );
      return getThreadRun(db, next.id);
    })
    .immediate();
}

export function updateThreadRun(
  db: DB,
  runId: number,
  patch: Partial<{
    state: ThreadRunState;
    turn_id: string | null;
    final_text: string | null;
    error_code: string | null;
    checkpoint_id: number | null;
  }>,
  fromStates?: ThreadRunState[],
): ThreadRun | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (sets.length === 0) return getThreadRun(db, runId);
  sets.push("updated_at = ?");
  params.push(nowIso(), runId);
  const stateClause =
    fromStates && fromStates.length > 0
      ? ` AND state IN (${fromStates.map(() => "?").join(",")})`
      : "";
  const res = db
    .prepare(`UPDATE thread_runs SET ${sets.join(", ")} WHERE id = ?${stateClause}`)
    .run(...params, ...(fromStates ?? []));
  if (!res.changes) return null;
  return getThreadRun(db, runId);
}

export function listQueuedRunIds(db: DB, threadId: string): number[] {
  return (
    db
      .prepare(`SELECT id FROM thread_runs WHERE thread_id = ? AND state = 'queued' ORDER BY id ASC`)
      .all(threadId) as Array<{ id: number }>
  ).map((r) => r.id);
}

// ---- Events ----

export function appendThreadEvent(
  db: DB,
  input: {
    threadId: string;
    runId?: number | null;
    type: ThreadEventType;
    payload: Record<string, unknown>;
  },
): ThreadEvent {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO thread_events (thread_id, run_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.threadId, input.runId ?? null, input.type, JSON.stringify(input.payload), now);
  return {
    seq: Number(res.lastInsertRowid),
    thread_id: input.threadId,
    run_id: input.runId ?? null,
    type: input.type,
    payload: input.payload,
    created_at: now,
  };
}

export function listThreadEvents(
  db: DB,
  threadId: string,
  afterSeq = 0,
  limit = 400,
): ThreadEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM thread_events
       WHERE thread_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(threadId, afterSeq, Math.max(1, Math.min(limit, 1000))) as EventRow[];
  return rows.map(toEvent);
}

// ---- Approvals ----

export function recordThreadApproval(
  db: DB,
  input: {
    threadId: string;
    runId: number;
    rpcRequestId: string;
    kind: ManagedApprovalKind;
    payload: Record<string, unknown>;
    state?: ApprovalState;
    decision?: ApprovalDecision | null;
    response?: Record<string, unknown> | null;
  },
): ThreadApproval {
  const now = nowIso();
  const state = input.state ?? "pending";
  const resolvedAt = state === "pending" ? null : now;
  const res = db
    .prepare(
      `INSERT INTO thread_approvals
       (thread_id, run_id, rpc_request_id, kind, payload_json, state, decision, response_json, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.threadId,
      input.runId,
      input.rpcRequestId,
      input.kind,
      JSON.stringify(input.payload),
      state,
      input.decision ?? null,
      input.response ? JSON.stringify(input.response) : null,
      now,
      resolvedAt,
    );
  return getThreadApproval(db, Number(res.lastInsertRowid))!;
}

export function getThreadApproval(db: DB, id: number): ThreadApproval | null {
  const row = db
    .prepare(
      `SELECT a.*, t.name AS thread_name, t.runtime AS runtime, t.project_id AS project_id, r.room_id AS room_id
       FROM thread_approvals a
       LEFT JOIN agent_threads t ON t.id = a.thread_id
       LEFT JOIN thread_runs r ON r.id = a.run_id
       WHERE a.id = ?`,
    )
    .get(id) as ApprovalRow | undefined;
  return row ? toApproval(row) : null;
}

export function listPendingThreadApprovals(
  db: DB,
  opts: { threadId?: string; roomId?: number } = {},
): ThreadApproval[] {
  const clauses = ["a.state = 'pending'"];
  const params: unknown[] = [];
  if (opts.threadId) {
    clauses.push("a.thread_id = ?");
    params.push(opts.threadId);
  }
  if (opts.roomId !== undefined) {
    clauses.push("r.room_id = ?");
    params.push(opts.roomId);
  }
  const rows = db
    .prepare(
      `SELECT a.*, t.name AS thread_name, t.runtime AS runtime, t.project_id AS project_id, r.room_id AS room_id
       FROM thread_approvals a
       LEFT JOIN agent_threads t ON t.id = a.thread_id
       LEFT JOIN thread_runs r ON r.id = a.run_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY a.id ASC`,
    )
    .all(...params) as ApprovalRow[];
  return rows.map(toApproval);
}

export function resolveThreadApprovalRow(
  db: DB,
  input: { approvalId: number; decision: ApprovalDecision; extra?: ApprovalResponseExtra },
): { ok: true; row: ThreadApproval } | { ok: false; status: number; reason: string } {
  const existing = getThreadApproval(db, input.approvalId);
  if (!existing) return { ok: false, status: 404, reason: "approval not found" };
  if (existing.state !== "pending") {
    return { ok: false, status: 409, reason: `approval already ${existing.state}` };
  }
  const responseObj = {
    decision: input.decision,
    ...(input.extra?.optionId ? { optionId: input.extra.optionId } : {}),
    ...(input.extra?.answers ? { answers: input.extra.answers } : {}),
  };
  const res = db
    .prepare(
      `UPDATE thread_approvals
       SET state = 'resolved', decision = ?, response_json = ?, resolved_at = ?
       WHERE id = ? AND state = 'pending'`,
    )
    .run(input.decision, JSON.stringify(responseObj), nowIso(), input.approvalId);
  if (!res.changes) return { ok: false, status: 409, reason: "approval already resolved" };
  return { ok: true, row: getThreadApproval(db, input.approvalId)! };
}

export function expireThreadApprovals(db: DB, threadId: string): number {
  const res = db
    .prepare(
      `UPDATE thread_approvals SET state = 'expired', resolved_at = ?
       WHERE thread_id = ? AND state = 'pending'`,
    )
    .run(nowIso(), threadId);
  return res.changes;
}

// ---- Checkpoints ----

export function recordThreadCheckpoint(
  db: DB,
  input: {
    threadId: string;
    runId: number | null;
    refName: string;
    treeSha: string;
    commitSha: string;
    summary?: string | null;
  },
): ThreadCheckpoint {
  const res = db
    .prepare(
      `INSERT INTO thread_checkpoints (thread_id, run_id, ref_name, tree_sha, commit_sha, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.threadId,
      input.runId,
      input.refName,
      input.treeSha,
      input.commitSha,
      input.summary ?? null,
      nowIso(),
    );
  return getThreadCheckpoint(db, Number(res.lastInsertRowid))!;
}

export function getThreadCheckpoint(db: DB, id: number): ThreadCheckpoint | null {
  const row = db.prepare(`SELECT * FROM thread_checkpoints WHERE id = ?`).get(id) as
    | CheckpointRow
    | undefined;
  return row ? toCheckpoint(row) : null;
}

export function listThreadCheckpoints(db: DB, threadId: string, limit = 50): ThreadCheckpoint[] {
  const rows = db
    .prepare(`SELECT * FROM thread_checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT ?`)
    .all(threadId, Math.max(1, Math.min(limit, 200))) as CheckpointRow[];
  return rows.map(toCheckpoint);
}
