import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { registerSession, endSession } from "./sessions.js";
import type { Agent, ModelConfig } from "@muiltchat/shared";

export type { Agent, ModelConfig };

interface AgentRow {
  id: number;
  name: string;
  system_prompt: string;
  model_config: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function toAgent(row: AgentRow): Agent {
  return {
    ...row,
    model_config: JSON.parse(row.model_config),
  };
}

export interface CreateAgentInput {
  name: string;
  system_prompt: string;
  model_config: ModelConfig;
  description?: string | null;
}

export function createAgent(db: DB, input: CreateAgentInput): Agent {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO agents (name, system_prompt, model_config, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.system_prompt,
      JSON.stringify(input.model_config),
      input.description ?? null,
      now,
      now
    );
  const agent = getAgent(db, Number(res.lastInsertRowid))!;
  // Register as a session so the agent is visible in the graph and can
  // participate in cross-session communication.
  registerSession(db, {
    id: `agent-${agent.id}`,
    name: agent.name,
    description: agent.description ?? "Internal agent",
    project_dir: null,
  });
  return agent;
}

export function getAgent(db: DB, id: number): Agent | null {
  const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as
    | AgentRow
    | undefined;
  return row ? toAgent(row) : null;
}

export function listAgents(db: DB): Agent[] {
  const rows = db
    .prepare(`SELECT * FROM agents ORDER BY updated_at DESC`)
    .all() as AgentRow[];
  return rows.map(toAgent);
}

export interface UpdateAgentInput {
  name?: string;
  system_prompt?: string;
  model_config?: ModelConfig;
  description?: string | null;
}

export function updateAgent(db: DB, id: number, input: UpdateAgentInput): Agent | null {
  const existing = getAgent(db, id);
  if (!existing) return null;
  const now = nowIso();
  db.prepare(
    `UPDATE agents SET
       name = ?,
       system_prompt = ?,
       model_config = ?,
       description = ?,
       updated_at = ?
     WHERE id = ?`
  ).run(
    input.name ?? existing.name,
    input.system_prompt ?? existing.system_prompt,
    input.model_config ? JSON.stringify(input.model_config) : JSON.stringify(existing.model_config),
    input.description !== undefined ? (input.description ?? null) : existing.description,
    now,
    id
  );
  return getAgent(db, id);
}

export function deleteAgent(db: DB, id: number): boolean {
  endSession(db, `agent-${id}`);
  const res = db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  return res.changes > 0;
}
