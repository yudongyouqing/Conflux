import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowStepState,
  WorkflowStepStatus,
} from "@conflux/shared";
import { WEB_CONSOLE_ID } from "@conflux/shared";
import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { askAndMaybeWake } from "./ask.js";
import { buildHandoffSummary } from "./handoff.js";
import { publishLiveEvent } from "./event-bus.js";
import { logger } from "../log.js";

/**
 * Multi-agent DAG workflow orchestration engine.
 *
 * A workflow defines a directed acyclic graph of steps (`agent` or
 * `human_gate`). Starting a run creates durable `workflow_runs` +
 * `workflow_steps` rows and automatically dispatches every step whose
 * upstream dependencies are `done`, interpolating upstream outputs and
 * optional structured handoff context. Managed sessions (Claude/Codex/
 * Antigravity/ACP) and external terminal sessions are driven identically
 * through `askAndMaybeWake`.
 */

interface WorkflowRow {
  id: number;
  name: string;
  description: string | null;
  room_id: number | null;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowRunRow {
  id: number;
  workflow_id: number;
  workflow_name?: string | null;
  room_id: number | null;
  status: string;
  input: string | null;
  initiated_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface WorkflowStepRow {
  id: number;
  run_id: number;
  step_key: string;
  title: string;
  kind: string;
  depends_on_json: string;
  target_session_id: string | null;
  prompt_template: string;
  include_handoff: number;
  status: string;
  message_id: number | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function toWorkflow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    room_id: row.room_id,
    steps: JSON.parse(row.steps_json) as WorkflowStepDefinition[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toStep(row: WorkflowStepRow): WorkflowStepState {
  return {
    id: row.id,
    run_id: row.run_id,
    step_key: row.step_key,
    title: row.title,
    kind: (row.kind === "human_gate" ? "human_gate" : "agent") as WorkflowStepKind,
    depends_on: JSON.parse(row.depends_on_json) as string[],
    target_session_id: row.target_session_id,
    prompt_template: row.prompt_template,
    include_handoff: Boolean(row.include_handoff),
    status: row.status as WorkflowStepStatus,
    message_id: row.message_id,
    output: row.output,
    error: row.error,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function toRun(db: DB, row: WorkflowRunRow): WorkflowRun {
  const stepRows = db
    .prepare(`SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY id ASC`)
    .all(row.id) as WorkflowStepRow[];
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    ...(row.workflow_name ? { workflow_name: row.workflow_name } : {}),
    room_id: row.room_id,
    status: row.status as WorkflowRunStatus,
    input: row.input,
    initiated_by: row.initiated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    steps: stepRows.map(toStep),
  };
}

/** Validate step keys, dependency references, and acyclicity (Kahn's algorithm). */
export function validateWorkflowSteps(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw badRequest("workflow must define at least one step");
  }
  const normalized: WorkflowStepDefinition[] = [];
  const keys = new Set<string>();
  for (const raw of steps) {
    const key = String(raw.key ?? "").trim();
    if (!key || !/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
      throw badRequest(`invalid step key: "${raw.key}" (expected alphanumeric/_/-)`);
    }
    if (keys.has(key)) throw badRequest(`duplicate step key: "${key}"`);
    keys.add(key);
    const title = String(raw.title ?? key).trim() || key;
    const kind: WorkflowStepKind = raw.kind === "human_gate" ? "human_gate" : "agent";
    const depends_on = Array.isArray(raw.depends_on)
      ? [...new Set(raw.depends_on.map((d) => String(d).trim()).filter(Boolean))]
      : [];
    const prompt_template = String(raw.prompt_template ?? "").trim();
    if (kind === "agent" && !prompt_template) {
      throw badRequest(`agent step "${key}" requires a non-empty prompt_template`);
    }
    if (kind === "agent" && !raw.target_session_id?.trim()) {
      throw badRequest(`agent step "${key}" requires target_session_id`);
    }
    normalized.push({
      key,
      title,
      kind,
      depends_on,
      target_session_id: raw.target_session_id?.trim() || null,
      prompt_template: prompt_template || `请审批步骤「${title}」`,
      include_handoff: Boolean(raw.include_handoff),
    });
  }

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of normalized) {
    inDegree.set(s.key, 0);
    adj.set(s.key, []);
  }
  for (const s of normalized) {
    for (const dep of s.depends_on) {
      if (!keys.has(dep)) throw badRequest(`step "${s.key}" depends on unknown step "${dep}"`);
      if (dep === s.key) throw badRequest(`step "${s.key}" cannot depend on itself`);
      adj.get(dep)!.push(s.key);
      inDegree.set(s.key, (inDegree.get(s.key) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [k, deg] of inDegree) {
    if (deg === 0) queue.push(k);
  }
  let visited = 0;
  while (queue.length > 0) {
    const curr = queue.shift()!;
    visited++;
    for (const next of adj.get(curr) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (visited !== normalized.length) {
    throw badRequest("workflow steps contain a cycle");
  }
  return normalized;
}

// ---- Workflow template CRUD ----

export function createWorkflow(
  db: DB,
  input: {
    name: string;
    description?: string | null;
    room_id?: number | null;
    steps: WorkflowStepDefinition[];
  },
): WorkflowDefinition {
  const name = input.name?.trim();
  if (!name) throw badRequest("workflow name is required");
  const steps = validateWorkflowSteps(input.steps);
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO workflows (name, description, room_id, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, input.description?.trim() || null, input.room_id ?? null, JSON.stringify(steps), now, now);
  return getWorkflow(db, Number(res.lastInsertRowid))!;
}

export function getWorkflow(db: DB, id: number): WorkflowDefinition | null {
  const row = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id) as WorkflowRow | undefined;
  return row ? toWorkflow(row) : null;
}

export function listWorkflows(db: DB, roomId?: number): WorkflowDefinition[] {
  const rows = (
    roomId !== undefined
      ? db.prepare(`SELECT * FROM workflows WHERE room_id = ? ORDER BY updated_at DESC`).all(roomId)
      : db.prepare(`SELECT * FROM workflows ORDER BY updated_at DESC`).all()
  ) as WorkflowRow[];
  return rows.map(toWorkflow);
}

export function deleteWorkflow(db: DB, id: number): boolean {
  const res = db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id);
  return res.changes > 0;
}

// ---- Workflow runs ----

export function getWorkflowRun(db: DB, runId: number): WorkflowRun | null {
  const row = db
    .prepare(
      `SELECT r.*, w.name AS workflow_name
       FROM workflow_runs r
       LEFT JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as WorkflowRunRow | undefined;
  return row ? toRun(db, row) : null;
}

export function listWorkflowRuns(db: DB, opts: { roomId?: number; workflowId?: number; limit?: number } = {}): WorkflowRun[] {
  const clauses: string[] = [];
  const params: number[] = [];
  if (opts.roomId !== undefined) {
    clauses.push("r.room_id = ?");
    params.push(opts.roomId);
  }
  if (opts.workflowId !== undefined) {
    clauses.push("r.workflow_id = ?");
    params.push(opts.workflowId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT r.*, w.name AS workflow_name
       FROM workflow_runs r
       LEFT JOIN workflows w ON w.id = r.workflow_id
       ${where}
       ORDER BY r.id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as WorkflowRunRow[];
  return rows.map((r) => toRun(db, r));
}

export async function startWorkflowRun(
  db: DB,
  workflowId: number,
  input: { input?: string | null; initiated_by?: string; room_id?: number | null } = {},
): Promise<WorkflowRun> {
  const workflow = getWorkflow(db, workflowId);
  if (!workflow) {
    throw Object.assign(new Error(`workflow not found: ${workflowId}`), { statusCode: 404 });
  }
  const initiatedBy = input.initiated_by?.trim() || WEB_CONSOLE_ID;
  const roomId = input.room_id !== undefined ? input.room_id : workflow.room_id;

  const runId = db
    .transaction(() => {
      const now = nowIso();
      const res = db
        .prepare(
          `INSERT INTO workflow_runs (workflow_id, room_id, status, input, initiated_by, created_at, updated_at)
           VALUES (?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(workflow.id, roomId ?? null, input.input?.trim() || null, initiatedBy, now, now);
      const id = Number(res.lastInsertRowid);
      const insertStep = db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_key, title, kind, depends_on_json, target_session_id, prompt_template, include_handoff, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      );
      for (const s of workflow.steps) {
        insertStep.run(
          id,
          s.key,
          s.title,
          s.kind,
          JSON.stringify(s.depends_on),
          s.target_session_id ?? null,
          s.prompt_template,
          s.include_handoff ? 1 : 0,
        );
      }
      return id;
    })
    .immediate();

  await advanceWorkflowRun(db, runId);
  return getWorkflowRun(db, runId)!;
}

function renderStepPrompt(
  db: DB,
  run: WorkflowRun,
  step: WorkflowStepState,
  allSteps: WorkflowStepState[],
): string {
  const byKey = new Map(allSteps.map((s) => [s.step_key, s]));
  let rendered = step.prompt_template.replace(/\{\{\s*input\s*\}\}/g, run.input ?? "");
  rendered = rendered.replace(/\{\{\s*step\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, key: string) => {
    return byKey.get(key)?.output ?? "";
  });

  const upstreamOutputs = step.depends_on
    .map((k) => byKey.get(k))
    .filter((s): s is WorkflowStepState => Boolean(s && s.output))
    .map((s) => ({ step_key: s.step_key, title: s.title, output: s.output! }));

  const parts: string[] = [
    `[工作流 #${run.id} · 步骤 ${step.title} (${step.step_key})]`,
    rendered,
  ];

  if (step.include_handoff) {
    const fromSessions = step.depends_on
      .map((k) => byKey.get(k)?.target_session_id)
      .filter((sid): sid is string => Boolean(sid));
    const handoff = buildHandoffSummary(db, {
      from_sessions: fromSessions,
      room_id: run.room_id,
      workflow_step_outputs: upstreamOutputs,
    });
    parts.push(`\n---\n### 自动交接上下文\n${handoff}`);
  } else if (upstreamOutputs.length > 0 && !step.prompt_template.includes("{{step.")) {
    const summary = upstreamOutputs
      .map((u) => `**${u.title} (${u.step_key})**:\n${u.output}`)
      .join("\n\n");
    parts.push(`\n---\n### 上游产出\n${summary}`);
  }

  return parts.join("\n");
}

/**
 * Evaluate the DAG for a run: promote eligible pending steps, pause at
 * human_gate steps, dispatch ready agent steps, and settle terminal status.
 */
export async function advanceWorkflowRun(db: DB, runId: number): Promise<WorkflowRun | null> {
  const run = getWorkflowRun(db, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }

  const byKey = new Map(run.steps.map((s) => [s.step_key, s]));
  const toDispatch: WorkflowStepState[] = [];

  db.transaction(() => {
    const now = nowIso();
    for (const step of run.steps) {
      if (step.status !== "pending") continue;
      const depsFailed = step.depends_on.some((k) => {
        const st = byKey.get(k)?.status;
        return st === "failed" || st === "skipped";
      });
      if (depsFailed) {
        db.prepare(`UPDATE workflow_steps SET status = 'skipped', completed_at = ? WHERE id = ?`).run(
          now,
          step.id,
        );
        step.status = "skipped";
        continue;
      }
      const allDepsDone = step.depends_on.every((k) => byKey.get(k)?.status === "done");
      if (!allDepsDone) continue;

      if (step.kind === "human_gate") {
        db.prepare(
          `UPDATE workflow_steps SET status = 'waiting_human', started_at = COALESCE(started_at, ?) WHERE id = ?`,
        ).run(now, step.id);
        step.status = "waiting_human";
      } else {
        db.prepare(
          `UPDATE workflow_steps SET status = 'ready', started_at = COALESCE(started_at, ?) WHERE id = ?`,
        ).run(now, step.id);
        step.status = "ready";
        toDispatch.push(step);
      }
    }
  }).immediate();

  // Dispatch ready agent steps strictly outside the DB transaction.
  for (const step of toDispatch) {
    if (!step.target_session_id) {
      db.prepare(
        `UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      ).run("missing target_session_id", nowIso(), step.id);
      continue;
    }
    const prompt = renderStepPrompt(db, run, step, run.steps);
    try {
      const outcome = await askAndMaybeWake(db, {
        from_session: run.initiated_by,
        to_session: step.target_session_id,
        question: prompt,
        room_id: run.room_id,
      });
      db.prepare(
        `UPDATE workflow_steps SET status = 'running', message_id = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'ready'`,
      ).run(outcome.message.id, nowIso(), step.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ runId, stepKey: step.step_key, err: msg }, "workflow step dispatch failed");
      db.prepare(
        `UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      ).run(msg.slice(0, 500), nowIso(), step.id);
    }
  }

  // Recompute aggregate run status.
  const latest = getWorkflowRun(db, runId);
  if (!latest) return null;
  const statuses = latest.steps.map((s) => s.status);
  let nextStatus: WorkflowRunStatus;
  let completedAt: string | null = null;
  if (statuses.some((s) => s === "waiting_human")) {
    nextStatus = "waiting_human";
  } else if (statuses.some((s) => s === "running" || s === "ready" || s === "pending")) {
    nextStatus = "running";
  } else if (statuses.some((s) => s === "failed")) {
    nextStatus = "failed";
    completedAt = nowIso();
  } else {
    nextStatus = "completed";
    completedAt = nowIso();
  }

  db.prepare(
    `UPDATE workflow_runs SET status = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?`,
  ).run(nextStatus, nowIso(), completedAt, runId);

  const updated = getWorkflowRun(db, runId)!;
  publishLiveEvent({
    type: "workflow.updated",
    room_id: updated.room_id,
    workflow_run_id: updated.id,
    payload: {
      run_id: updated.id,
      workflow_id: updated.workflow_id,
      status: updated.status,
      steps: updated.steps.map((s) => ({
        id: s.id,
        step_key: s.step_key,
        status: s.status,
      })),
    },
  });
  return updated;
}

export async function approveHumanGate(
  db: DB,
  stepId: number,
  input: { approved: boolean; comment?: string | null },
): Promise<WorkflowRun> {
  const row = db.prepare(`SELECT * FROM workflow_steps WHERE id = ?`).get(stepId) as
    | WorkflowStepRow
    | undefined;
  if (!row) throw Object.assign(new Error(`workflow step not found: ${stepId}`), { statusCode: 404 });
  if (row.kind !== "human_gate") {
    throw badRequest("only human_gate steps can be approved");
  }
  if (row.status !== "waiting_human") {
    throw Object.assign(new Error(`step is not waiting for approval (status: ${row.status})`), {
      statusCode: 409,
    });
  }
  const now = nowIso();
  if (input.approved) {
    db.prepare(
      `UPDATE workflow_steps SET status = 'done', output = ?, completed_at = ? WHERE id = ?`,
    ).run(input.comment?.trim() || "已批准放行", now, stepId);
  } else {
    db.prepare(
      `UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
    ).run(input.comment?.trim() || "人工审批驳回", now, stepId);
  }
  return (await advanceWorkflowRun(db, row.run_id))!;
}

export async function completeWorkflowStep(
  db: DB,
  stepId: number,
  input: { status?: "done" | "failed"; output?: string | null; error?: string | null },
): Promise<WorkflowRun> {
  const row = db.prepare(`SELECT * FROM workflow_steps WHERE id = ?`).get(stepId) as
    | WorkflowStepRow
    | undefined;
  if (!row) throw Object.assign(new Error(`workflow step not found: ${stepId}`), { statusCode: 404 });
  const status = input.status ?? "done";
  db.prepare(
    `UPDATE workflow_steps SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ?`,
  ).run(status, input.output ?? null, input.error ?? null, nowIso(), stepId);
  return (await advanceWorkflowRun(db, row.run_id))!;
}

export function cancelWorkflowRun(db: DB, runId: number): WorkflowRun | null {
  const existing = getWorkflowRun(db, runId);
  if (!existing) return null;
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE workflow_steps SET status = 'skipped', completed_at = ?
       WHERE run_id = ? AND status IN ('pending', 'ready', 'waiting_human')`,
    ).run(now, runId);
    db.prepare(
      `UPDATE workflow_runs SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?`,
    ).run(now, now, runId);
  }).immediate();
  const updated = getWorkflowRun(db, runId)!;
  publishLiveEvent({
    type: "workflow.updated",
    room_id: updated.room_id,
    workflow_run_id: updated.id,
    payload: { run_id: updated.id, workflow_id: updated.workflow_id, status: updated.status },
  });
  return updated;
}

/**
 * Called whenever a message receives a reply (either via ManagedExecutor
 * finalizeTurn or via external MCP/HTTP reply_ask). If a running workflow
 * step is bound to that message, mark it done/failed and advance the DAG.
 */
export async function onWorkflowStepMessageCompleted(
  db: DB,
  messageId: number,
  outcome: { state: "completed" | "failed" | "interrupted"; text: string | null; error?: string | null },
): Promise<boolean> {
  const row = db
    .prepare(`SELECT * FROM workflow_steps WHERE message_id = ? AND status = 'running'`)
    .get(messageId) as WorkflowStepRow | undefined;
  if (!row) return false;
  const now = nowIso();
  if (outcome.state === "completed") {
    db.prepare(
      `UPDATE workflow_steps SET status = 'done', output = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
    ).run(outcome.text ?? "", now, row.id);
  } else {
    db.prepare(
      `UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
    ).run(outcome.error ?? `step ${outcome.state}`, now, row.id);
  }
  await advanceWorkflowRun(db, row.run_id);
  return true;
}
