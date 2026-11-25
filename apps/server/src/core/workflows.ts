import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowStepState,
  WorkflowStepStatus,
} from "@conflux/shared";
import { nowIso, type DB } from "./db.js";
import { askThread } from "./messages.js";
import { buildHandoffSummary } from "./handoff.js";
import { publishLiveEvent } from "./event-bus.js";
import { onThreadTurnFinalized } from "./threads/executor.js";
import { logger } from "../log.js";

interface WorkflowRow {
  id: number;
  name: string;
  description: string | null;
  project_id: number | null;
  room_id: number | null;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowRunRow {
  id: number;
  workflow_id: number;
  workflow_name?: string;
  project_id: number | null;
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
  target_thread_id: string | null;
  prompt_template: string;
  include_handoff: number;
  status: string;
  message_id: number | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** Validate DAG step definitions and reject cycles via Kahn's topological sort. */
export function validateWorkflowSteps(rawSteps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw Object.assign(new Error("workflow must define at least one step"), { statusCode: 400 });
  }
  const seen = new Set<string>();
  const normalized: WorkflowStepDefinition[] = rawSteps.map((s, idx) => {
    const key = String(s.key ?? "").trim();
    if (!key || !/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
      throw Object.assign(new Error(`invalid step key at index ${idx}`), { statusCode: 400 });
    }
    if (seen.has(key)) {
      throw Object.assign(new Error(`duplicate step key: ${key}`), { statusCode: 400 });
    }
    seen.add(key);
    const kind: WorkflowStepKind = s.kind === "human_gate" ? "human_gate" : "agent";
    const deps = Array.isArray(s.depends_on)
      ? [...new Set(s.depends_on.map((d) => String(d).trim()).filter(Boolean))]
      : [];
    return {
      key,
      title: String(s.title ?? key).trim() || key,
      kind,
      depends_on: deps,
      target_thread_id: s.target_thread_id ?? null,
      prompt_template: String(s.prompt_template ?? ""),
      include_handoff: Boolean(s.include_handoff),
    };
  });

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const step of normalized) {
    inDegree.set(step.key, 0);
    adj.set(step.key, []);
  }
  for (const step of normalized) {
    for (const dep of step.depends_on) {
      if (!seen.has(dep)) {
        throw Object.assign(new Error(`step "${step.key}" depends on unknown step "${dep}"`), {
          statusCode: 400,
        });
      }
      if (dep === step.key) {
        throw Object.assign(new Error(`step "${step.key}" cannot depend on itself`), {
          statusCode: 400,
        });
      }
      adj.get(dep)!.push(step.key);
      inDegree.set(step.key, (inDegree.get(step.key) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [k, deg] of inDegree) if (deg === 0) queue.push(k);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited++;
    for (const next of adj.get(cur) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (visited !== normalized.length) {
    throw Object.assign(new Error("workflow DAG contains a dependency cycle"), { statusCode: 400 });
  }
  return normalized;
}

function toWorkflow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    project_id: row.project_id,
    room_id: row.room_id,
    steps: JSON.parse(row.steps_json) as WorkflowStepDefinition[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toStepState(row: WorkflowStepRow): WorkflowStepState {
  return {
    id: row.id,
    run_id: row.run_id,
    step_key: row.step_key,
    title: row.title,
    kind: row.kind as WorkflowStepKind,
    depends_on: JSON.parse(row.depends_on_json) as string[],
    target_thread_id: row.target_thread_id,
    prompt_template: row.prompt_template,
    include_handoff: row.include_handoff === 1,
    status: row.status as WorkflowStepStatus,
    message_id: row.message_id,
    output: row.output,
    error: row.error,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

export function createWorkflow(
  db: DB,
  input: {
    name: string;
    description?: string | null;
    project_id?: number | null;
    room_id?: number | null;
    steps: WorkflowStepDefinition[];
  },
): WorkflowDefinition {
  const name = input.name?.trim();
  if (!name) throw Object.assign(new Error("workflow name is required"), { statusCode: 400 });
  const steps = validateWorkflowSteps(input.steps);
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO workflows (name, description, project_id, room_id, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      input.description?.trim() || null,
      input.project_id ?? null,
      input.room_id ?? null,
      JSON.stringify(steps),
      now,
      now,
    );
  return getWorkflow(db, Number(res.lastInsertRowid))!;
}

export function getWorkflow(db: DB, id: number): WorkflowDefinition | null {
  const row = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id) as WorkflowRow | undefined;
  return row ? toWorkflow(row) : null;
}

export function listWorkflows(
  db: DB,
  opts: { project_id?: number | null; room_id?: number } = {},
): WorkflowDefinition[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.project_id !== undefined) {
    if (opts.project_id === null) clauses.push("project_id IS NULL");
    else {
      clauses.push("project_id = ?");
      params.push(opts.project_id);
    }
  }
  if (opts.room_id !== undefined) {
    clauses.push("room_id = ?");
    params.push(opts.room_id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM workflows ${where} ORDER BY updated_at DESC, id DESC`)
    .all(...params) as WorkflowRow[];
  return rows.map(toWorkflow);
}

export function deleteWorkflow(db: DB, id: number): boolean {
  return db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id).changes > 0;
}

export function getWorkflowRun(db: DB, runId: number): WorkflowRun | null {
  const row = db
    .prepare(
      `SELECT r.*, w.name AS workflow_name
       FROM workflow_runs r
       LEFT JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as WorkflowRunRow | undefined;
  if (!row) return null;
  const steps = (
    db.prepare(`SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY id ASC`).all(runId) as WorkflowStepRow[]
  ).map(toStepState);
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    workflow_name: row.workflow_name,
    project_id: row.project_id,
    room_id: row.room_id,
    status: row.status as WorkflowRunStatus,
    input: row.input,
    initiated_by: row.initiated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    steps,
  };
}

export function listWorkflowRuns(
  db: DB,
  opts: { project_id?: number; room_id?: number; workflow_id?: number; limit?: number } = {},
): WorkflowRun[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.project_id !== undefined) {
    clauses.push("r.project_id = ?");
    params.push(opts.project_id);
  }
  if (opts.room_id !== undefined) {
    clauses.push("r.room_id = ?");
    params.push(opts.room_id);
  }
  if (opts.workflow_id !== undefined) {
    clauses.push("r.workflow_id = ?");
    params.push(opts.workflow_id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const rows = db
    .prepare(`SELECT r.id FROM workflow_runs r ${where} ORDER BY r.id DESC LIMIT ?`)
    .all(...params, limit) as Array<{ id: number }>;
  return rows.map((r) => getWorkflowRun(db, r.id)!).filter(Boolean);
}

export async function startWorkflowRun(
  db: DB,
  workflowId: number,
  opts: { input?: string; project_id?: number | null; room_id?: number | null; initiated_by: string },
): Promise<WorkflowRun> {
  const wf = getWorkflow(db, workflowId);
  if (!wf) throw Object.assign(new Error("workflow not found"), { statusCode: 404 });
  const now = nowIso();
  const projectId = opts.project_id !== undefined ? opts.project_id : wf.project_id;
  const roomId = opts.room_id !== undefined ? opts.room_id : wf.room_id;

  const runId = db
    .transaction(() => {
      const res = db
        .prepare(
          `INSERT INTO workflow_runs (workflow_id, project_id, room_id, status, input, initiated_by, created_at, updated_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(wf.id, projectId, roomId, opts.input ?? null, opts.initiated_by, now, now);
      const id = Number(res.lastInsertRowid);
      const stmt = db.prepare(
        `INSERT INTO workflow_steps
         (run_id, step_key, title, kind, depends_on_json, target_thread_id, prompt_template, include_handoff, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      );
      for (const step of wf.steps) {
        stmt.run(
          id,
          step.key,
          step.title,
          step.kind,
          JSON.stringify(step.depends_on),
          step.target_thread_id ?? null,
          step.prompt_template,
          step.include_handoff ? 1 : 0,
        );
      }
      return id;
    })
    .immediate();

  return (await advanceWorkflowRun(db, runId))!;
}

function renderStepPrompt(
  db: DB,
  run: WorkflowRun,
  step: WorkflowStepState,
  allSteps: WorkflowStepState[],
): string {
  const byKey = new Map(allSteps.map((s) => [s.step_key, s]));
  let rendered = step.prompt_template || step.title;
  rendered = rendered.replace(/\{\{\s*input\s*\}\}/g, run.input ?? "");
  rendered = rendered.replace(/\{\{\s*step\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, key: string) => {
    return byKey.get(key)?.output ?? "";
  });

  const upstreamOutputs = step.depends_on
    .map((k) => byKey.get(k))
    .filter((s): s is WorkflowStepState => Boolean(s && s.output))
    .map((s) => ({ step_key: s.step_key, title: s.title, output: s.output! }));

  const parts = [`[工作流 #${run.id} · 步骤 ${step.step_key}: ${step.title}]`, rendered];
  if (step.include_handoff) {
    const fromThreads = step.depends_on
      .map((k) => byKey.get(k)?.target_thread_id)
      .filter((tid): tid is string => Boolean(tid));
    const handoff = buildHandoffSummary(db, {
      from_threads: fromThreads,
      project_id: run.project_id,
      room_id: run.room_id,
      workflow_step_outputs: upstreamOutputs,
    });
    parts.push(`\n---\n### 自动交接上下文\n${handoff}`);
  } else if (upstreamOutputs.length > 0 && !step.prompt_template.includes("{{step.")) {
    const summary = upstreamOutputs.map((u) => `**${u.title} (${u.step_key})**:\n${u.output}`).join("\n\n");
    parts.push(`\n---\n### 上游产出\n${summary}`);
  }
  return parts.join("\n");
}

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

  for (const step of toDispatch) {
    if (!step.target_thread_id) {
      db.prepare(
        `UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      ).run("missing target_thread_id", nowIso(), step.id);
      continue;
    }
    const prompt = renderStepPrompt(db, run, step, run.steps);
    try {
      const outcome = await askThread(db, {
        from_thread: run.initiated_by,
        to_thread: step.target_thread_id,
        question: prompt,
        room_id: run.room_id,
      });
      db.prepare(
        `UPDATE workflow_steps SET status = 'running', message_id = ?, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'ready'`,
      ).run(outcome.message.id, nowIso(), step.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ runId, stepKey: step.step_key, err: msg }, "workflow step dispatch failed");
      db.prepare(
        `UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      ).run(msg.slice(0, 500), nowIso(), step.id);
    }
  }

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
    project_id: updated.project_id,
    room_id: updated.room_id,
    workflow_run_id: updated.id,
    payload: {
      run_id: updated.id,
      workflow_id: updated.workflow_id,
      status: updated.status,
      steps: updated.steps.map((s) => ({ id: s.id, step_key: s.step_key, status: s.status })),
    },
  });
  return updated;
}

export async function approveHumanGate(
  db: DB,
  stepId: number,
  input: { approved: boolean; comment?: string },
): Promise<WorkflowRun> {
  const row = db.prepare(`SELECT * FROM workflow_steps WHERE id = ?`).get(stepId) as
    | WorkflowStepRow
    | undefined;
  if (!row) throw Object.assign(new Error("workflow step not found"), { statusCode: 404 });
  if (row.kind !== "human_gate") {
    throw Object.assign(new Error("step is not a human_gate"), { statusCode: 400 });
  }
  if (row.status !== "waiting_human") {
    throw Object.assign(new Error(`step is not waiting for approval (status=${row.status})`), {
      statusCode: 409,
    });
  }
  const now = nowIso();
  if (input.approved) {
    db.prepare(`UPDATE workflow_steps SET status = 'done', output = ?, completed_at = ? WHERE id = ?`).run(
      input.comment?.trim() || "人工审批通过",
      now,
      stepId,
    );
  } else {
    db.prepare(`UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`).run(
      input.comment?.trim() || "人工审批拒绝",
      now,
      stepId,
    );
  }
  return (await advanceWorkflowRun(db, row.run_id))!;
}

export async function completeWorkflowStep(
  db: DB,
  stepId: number,
  input: { status?: "done" | "failed"; output?: string; error?: string },
): Promise<WorkflowRun> {
  const row = db.prepare(`SELECT * FROM workflow_steps WHERE id = ?`).get(stepId) as
    | WorkflowStepRow
    | undefined;
  if (!row) throw Object.assign(new Error("workflow step not found"), { statusCode: 404 });
  const nextStatus = input.status === "failed" ? "failed" : "done";
  db.prepare(
    `UPDATE workflow_steps SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ?`,
  ).run(nextStatus, input.output ?? null, input.error ?? null, nowIso(), stepId);
  return (await advanceWorkflowRun(db, row.run_id))!;
}

export function cancelWorkflowRun(db: DB, runId: number): WorkflowRun | null {
  const run = getWorkflowRun(db, runId);
  if (!run) return null;
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
    project_id: updated.project_id,
    room_id: updated.room_id,
    workflow_run_id: updated.id,
    payload: { run_id: updated.id, status: "cancelled" },
  });
  return updated;
}

export async function onWorkflowStepMessageCompleted(
  db: DB,
  messageId: number,
  result: { ok: boolean; output?: string | null; error?: string | null },
): Promise<void> {
  const step = db
    .prepare(`SELECT id, run_id, status FROM workflow_steps WHERE message_id = ?`)
    .get(messageId) as { id: number; run_id: number; status: string } | undefined;
  if (!step || step.status === "done" || step.status === "failed" || step.status === "skipped") {
    return;
  }
  await completeWorkflowStep(db, step.id, {
    status: result.ok ? "done" : "failed",
    output: result.output ?? undefined,
    error: result.error ?? undefined,
  });
}

let workflowHookInstalled = false;

export function installWorkflowHooks(): void {
  if (workflowHookInstalled) return;
  workflowHookInstalled = true;
  onThreadTurnFinalized(({ db, messageId, state, finalText, errorCode }) => {
    if (!db.open || !messageId) return;
    void onWorkflowStepMessageCompleted(db, messageId, {
      ok: state === "completed",
      output: finalText,
      error: state === "interrupted" ? "任务被中断" : errorCode,
    }).catch((err) => {
      logger.warn({ err, messageId }, "workflow auto-advance failed");
    });
  });
}
