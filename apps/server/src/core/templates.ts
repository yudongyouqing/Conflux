import type { AgentTemplate, ApprovalMode, RuntimeId } from "@conflux/shared";
import { nowIso, type DB } from "./db.js";

const VALID_RUNTIMES = new Set<RuntimeId>(["claude", "codex", "antigravity", "acp"]);

interface TemplateRow {
  id: number;
  name: string;
  runtime: string;
  model: string | null;
  instructions: string | null;
  extra_env: string | null;
  approval_mode: string;
  use_worktree: number;
  created_at: string;
  updated_at: string;
}

function toTemplate(row: TemplateRow): AgentTemplate {
  return {
    id: row.id,
    name: row.name,
    runtime: row.runtime as RuntimeId,
    model: row.model,
    instructions: row.instructions,
    extra_env: row.extra_env,
    approval_mode: (row.approval_mode === "auto" ? "auto" : "ask") as ApprovalMode,
    use_worktree: row.use_worktree === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listTemplates(db: DB): AgentTemplate[] {
  const rows = db
    .prepare(`SELECT * FROM agent_templates ORDER BY id DESC`)
    .all() as TemplateRow[];
  return rows.map(toTemplate);
}

export function getTemplate(db: DB, id: number): AgentTemplate | null {
  const row = db.prepare(`SELECT * FROM agent_templates WHERE id = ?`).get(id) as
    | TemplateRow
    | undefined;
  return row ? toTemplate(row) : null;
}

export function createTemplate(
  db: DB,
  input: {
    name: string;
    runtime: RuntimeId;
    model?: string | null;
    instructions?: string | null;
    extra_env?: string | null;
    approval_mode?: ApprovalMode;
    use_worktree?: boolean;
  },
): AgentTemplate {
  const name = input.name?.trim();
  if (!name) throw Object.assign(new Error("template name is required"), { statusCode: 400 });
  if (!VALID_RUNTIMES.has(input.runtime)) {
    throw Object.assign(new Error(`invalid runtime: ${input.runtime}`), { statusCode: 400 });
  }
  const approvalMode: ApprovalMode = input.approval_mode === "auto" ? "auto" : "ask";
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO agent_templates
       (name, runtime, model, instructions, extra_env, approval_mode, use_worktree, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      input.runtime,
      input.model?.trim() || null,
      input.instructions?.trim() || null,
      input.extra_env?.trim() || null,
      approvalMode,
      input.use_worktree ? 1 : 0,
      now,
      now,
    );
  return getTemplate(db, Number(res.lastInsertRowid))!;
}

export function deleteTemplate(db: DB, id: number): boolean {
  return db.prepare(`DELETE FROM agent_templates WHERE id = ?`).run(id).changes > 0;
}
