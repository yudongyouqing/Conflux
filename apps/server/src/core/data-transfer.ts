import { randomUUID } from "node:crypto";
import type {
  Agent,
  ConfluxDataBundle,
  ContextEntry,
  Conversation,
  DataBundleScope,
  ExportedRuntimeAgent,
  GraphEdge,
  Message,
  RuntimeAgent,
  Session,
  Turn,
} from "@muiltchat/shared";
import { z } from "zod";

import type { DB } from "./db.js";
import { nowIso } from "./db.js";

export type { ConfluxDataBundle, DataBundleScope, ExportedRuntimeAgent } from "@muiltchat/shared";

export type ImportConflictStrategy = "skip" | "overwrite" | "copy";

export interface ExportDataOptions {
  scope?: DataBundleScope;
  projectDir?: string;
}

export interface ImportDataOptions {
  conflict?: ImportConflictStrategy;
  projectDir?: string;
}

export interface ImportDataResult {
  conflict: ImportConflictStrategy;
  imported: number;
  skipped: number;
  overwritten: number;
  copied: number;
}

const isoTimestamp = z.string().refine(
  (value) => value.length > 0 && !Number.isNaN(Date.parse(value)),
  "must be an ISO timestamp"
);
const nullableString = z.string().nullable();
const modelConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().optional(),
    max_tokens: z.number().int().optional(),
  })
  .strict();

const sessionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: nullableString,
    project_dir: nullableString,
    status: z.enum(["active", "stale", "ended"]),
    created_at: isoTimestamp,
    last_heartbeat_at: isoTimestamp,
    metadata: nullableString,
    runtime: z.enum(["claude", "codex", "internal", "web"]).nullable(),
    identity_source: z.enum(["hook", "mcp", "http", "cli", "internal"]).nullable(),
    runtime_pid: z.number().int().nullable(),
  })
  .strict();

const contextSchema = z
  .object({
    id: z.number().int().nonnegative(),
    session_id: z.string().min(1),
    title: z.string(),
    content: z.string(),
    tags: z.array(z.string()).nullable(),
    created_at: isoTimestamp,
    updated_at: isoTimestamp,
  })
  .strict();

const messageSchema = z
  .object({
    id: z.number().int().nonnegative(),
    edge_id: z.number().int().positive().nullable(),
    from_session: z.string().min(1),
    to_session: z.string().min(1),
    question: z.string(),
    reply: nullableString,
    status: z.enum(["pending", "seen", "replied", "read"]),
    created_at: isoTimestamp,
    replied_at: isoTimestamp.nullable(),
  })
  .strict();

const edgeSchema = z
  .object({
    id: z.number().int().positive(),
    from: z.string().min(1),
    to: z.string().min(1),
    weight: z.number().int().nonnegative(),
    last_interact_at: isoTimestamp,
    last_message: nullableString.optional(),
  })
  .strict();

const agentSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    system_prompt: z.string(),
    model_config: modelConfigSchema,
    description: nullableString,
    created_at: isoTimestamp,
    updated_at: isoTimestamp,
  })
  .strict();

const conversationSchema = z
  .object({
    id: z.number().int().nonnegative(),
    agent_id: z.number().int().nonnegative(),
    initiated_by: nullableString,
    title: nullableString,
    created_at: isoTimestamp,
    updated_at: isoTimestamp,
  })
  .strict();

const turnSchema = z
  .object({
    id: z.number().int().nonnegative(),
    conversation_id: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    created_at: isoTimestamp,
  })
  .strict();

const runtimeAgentSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    runtime: z.enum(["claude", "codex"]),
    workdir: nullableString,
    model: nullableString,
    base_url: nullableString,
    extra_env: nullableString,
    instructions: nullableString,
    interval_min: z.number().int().nullable(),
    last_scheduled_run: isoTimestamp.nullable(),
    created_at: isoTimestamp,
    updated_at: isoTimestamp,
    api_key_configured: z.boolean(),
  })
  .strict();

const bundleSchema = z
  .object({
    format: z.literal("conflux-data"),
    version: z.literal(1),
    exported_at: isoTimestamp,
    scope: z.enum(["global", "project"]),
    sessions: z.array(sessionSchema),
    context_entries: z.array(contextSchema),
    messages: z.array(messageSchema),
    edges: z.array(edgeSchema),
    agents: z.array(agentSchema),
    conversations: z.array(conversationSchema),
    turns: z.array(turnSchema),
    runtime_agents: z.array(runtimeAgentSchema),
  })
  .strict();

type SessionRow = Session;
type ContextRow = Omit<ContextEntry, "tags"> & { tags: string | null };
type AgentRow = Omit<Agent, "model_config"> & { model_config: string };
type RuntimeAgentRow = Omit<RuntimeAgent, "runtime" | "live" | "last_seen"> & {
  runtime: string;
};

export function exportData(
  db: DB,
  options: ExportDataOptions = {}
): ConfluxDataBundle {
  const scope = options.scope ?? "global";
  const allSessions = db.prepare("SELECT * FROM sessions ORDER BY created_at ASC, id ASC").all() as SessionRow[];
  const sessionRows = scope === "project"
    ? allSessions.filter((session) => isProjectSession(session, options.projectDir))
    : allSessions;
  const sessionIds = new Set(sessionRows.map((session) => session.id));
  const placeholders = [...sessionIds].map(() => "?").join(",");

  const contexts = placeholders
    ? (db
        .prepare(
          `SELECT * FROM context_entries WHERE session_id IN (${placeholders}) ORDER BY id ASC`
        )
        .all(...sessionIds) as ContextRow[])
    : [];
  const messages = placeholders
    ? (db
        .prepare(
          `SELECT * FROM messages
           WHERE from_session IN (${placeholders}) AND to_session IN (${placeholders})
           ORDER BY id ASC`
        )
        .all(...sessionIds, ...sessionIds) as Message[])
    : [];
  const edges = placeholders
    ? (db
        .prepare(
          `SELECT rowid AS id, from_session AS "from", to_session AS "to",
             weight, last_interact_at
           FROM edges
           WHERE from_session IN (${placeholders}) AND to_session IN (${placeholders})
           ORDER BY rowid ASC`
        )
        .all(...sessionIds, ...sessionIds) as GraphEdge[])
    : [];

  const allConversations = db
    .prepare("SELECT * FROM conversations ORDER BY id ASC")
    .all() as Conversation[];
  const conversations = scope === "project"
    ? allConversations.filter(
        (conversation) => conversation.initiated_by !== null && sessionIds.has(conversation.initiated_by)
      )
    : allConversations;
  const conversationIds = new Set(conversations.map((conversation) => conversation.id));
  const turns = conversationIds.size
    ? (db
        .prepare(
          `SELECT * FROM turns WHERE conversation_id IN (${[...conversationIds].map(() => "?").join(",")}) ORDER BY id ASC`
        )
        .all(...conversationIds) as Turn[])
    : [];
  const agentIds = new Set(conversations.map((conversation) => conversation.agent_id));
  const agents = scope === "project"
    ? (agentIds.size
        ? (db
            .prepare(
              `SELECT * FROM agents WHERE id IN (${[...agentIds].map(() => "?").join(",")}) ORDER BY id ASC`
            )
            .all(...agentIds) as AgentRow[])
        : [])
    : (db.prepare("SELECT * FROM agents ORDER BY id ASC").all() as AgentRow[]);
  const runtimeRows = db
    .prepare(
      `SELECT id, name, runtime, workdir, model, base_url, extra_env, instructions,
         interval_min, last_scheduled_run, created_at, updated_at,
         CASE WHEN api_key IS NOT NULL AND length(api_key) > 0 THEN 1 ELSE 0 END AS api_key_configured
       FROM runtime_agents ORDER BY id ASC`
    )
    .all() as (RuntimeAgentRow & { api_key_configured: number })[];
  const runtimeAgents = (scope === "project"
    ? runtimeRows.filter((agent) => isProjectPath(agent.workdir, options.projectDir))
    : runtimeRows
  ).map((agent) => {
    const { api_key_configured, ...portable } = agent;
    return { ...portable, api_key_configured: api_key_configured === 1 } as ExportedRuntimeAgent;
  });

  return {
    format: "conflux-data",
    version: 1,
    exported_at: nowIso(),
    scope,
    sessions: sessionRows,
    context_entries: contexts.map((row) => ({
      ...row,
      tags: row.tags ? parseStringArray(row.tags, "context tags") : null,
    })),
    messages,
    edges,
    agents: agents.map((row) => ({
      ...row,
      model_config: parseModelConfig(row.model_config),
    })),
    conversations,
    turns,
    runtime_agents: runtimeAgents,
  } as ConfluxDataBundle;
}

export function parseDataBundle(input: unknown): ConfluxDataBundle {
  const result = bundleSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "bundle";
    throw new Error(`invalid data bundle at ${path}: ${issue?.message ?? "invalid value"}`);
  }
  validateReferences(result.data);
  return result.data as ConfluxDataBundle;
}

export function importData(
  db: DB,
  input: unknown,
  options: ImportDataOptions = {}
): ImportDataResult {
  const bundle = parseDataBundle(input);
  const conflict = options.conflict ?? "skip";
  if (!["skip", "overwrite", "copy"].includes(conflict)) {
    throw new Error(`invalid import conflict strategy: ${conflict}`);
  }

  const result: ImportDataResult = {
    conflict,
    imported: 0,
    skipped: 0,
    overwritten: 0,
    copied: 0,
  };

  const transaction = db.transaction(() => {
    const agentMap = importAgents(db, bundle.agents, conflict, result);
    const sessionMap = importSessions(db, bundle.sessions, conflict, result, agentMap);
    importRuntimeAgents(db, bundle.runtime_agents, conflict, result);
    const edgeMap = importEdges(db, bundle.edges, sessionMap, conflict, result);
    importContexts(db, bundle.context_entries, sessionMap, conflict, result);
    const conversationMap = importConversations(
      db,
      bundle.conversations,
      sessionMap,
      agentMap,
      conflict,
      result
    );
    importTurns(db, bundle.turns, conversationMap, conflict, result);
    importMessages(db, bundle.messages, sessionMap, edgeMap, conflict, result);
  });
  transaction();
  return result;
}

function validateReferences(bundle: z.infer<typeof bundleSchema>): void {
  assertUnique(bundle.sessions.map((row) => row.id), "session id");
  assertUnique(bundle.context_entries.map((row) => row.id), "context id");
  assertUnique(bundle.messages.map((row) => row.id), "message id");
  assertUnique(bundle.edges.map((row) => row.id), "edge id");
  assertUnique(bundle.agents.map((row) => row.id), "agent id");
  assertUnique(bundle.conversations.map((row) => row.id), "conversation id");
  assertUnique(bundle.turns.map((row) => row.id), "turn id");
  assertUnique(bundle.runtime_agents.map((row) => row.id), "runtime agent id");

  const sessions = new Set(bundle.sessions.map((row) => row.id));
  const edges = new Set(bundle.edges.map((row) => row.id));
  const agents = new Set(bundle.agents.map((row) => row.id));
  const conversations = new Set(bundle.conversations.map((row) => row.id));
  for (const row of bundle.context_entries) {
    assertReference(sessions, row.session_id, `context_entries[${row.id}].session_id`);
  }
  for (const row of bundle.edges) {
    assertReference(sessions, row.from, `edges[${row.id}].from`);
    assertReference(sessions, row.to, `edges[${row.id}].to`);
  }
  for (const row of bundle.messages) {
    assertReference(sessions, row.from_session, `messages[${row.id}].from_session`);
    assertReference(sessions, row.to_session, `messages[${row.id}].to_session`);
    if (row.edge_id !== null) assertReference(edges, row.edge_id, `messages[${row.id}].edge_id`);
  }
  for (const row of bundle.conversations) {
    assertReference(agents, row.agent_id, `conversations[${row.id}].agent_id`);
  }
  for (const row of bundle.turns) {
    assertReference(conversations, row.conversation_id, `turns[${row.id}].conversation_id`);
  }
}

function importSessions(
  db: DB,
  rows: Session[],
  conflict: ImportConflictStrategy,
  result: ImportDataResult,
  agentMap: Map<number, number>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const targetId = canonicalAgentSessionId(row.id, agentMap) ?? row.id;
    const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(targetId);
    if (!existing) {
      insertSession(db, row, targetId);
      map.set(row.id, targetId);
      if (conflict === "copy") result.copied++;
      else result.imported++;
      continue;
    }
    if (conflict === "skip") {
      map.set(row.id, row.id);
      result.skipped++;
      continue;
    }
    if (conflict === "overwrite") {
      updateSession(db, row, targetId);
      map.set(row.id, targetId);
      result.overwritten++;
      continue;
    }
    const id = copyId(db, "sessions", targetId);
    insertSession(db, row, id);
    map.set(row.id, id);
    result.copied++;
  }
  return map;
}

function importAgents(
  db: DB,
  rows: Agent[],
  conflict: ImportConflictStrategy,
  result: ImportDataResult
): Map<number, number> {
  const map = new Map<number, number>();
  const sourceIds = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    const existing = db.prepare("SELECT id FROM agents WHERE id = ?").get(row.id);
    if (!existing) {
      insertAgent(db, row, row.id);
      map.set(row.id, row.id);
      result.imported++;
      continue;
    }
    if (conflict === "skip") {
      map.set(row.id, row.id);
      result.skipped++;
      continue;
    }
    if (conflict === "overwrite") {
      updateAgent(db, row, row.id);
      map.set(row.id, row.id);
      result.overwritten++;
      continue;
    }
    const id = insertAgentCopy(db, row, sourceIds);
    map.set(row.id, id);
    result.copied++;
  }
  return map;
}

function importRuntimeAgents(
  db: DB,
  rows: ExportedRuntimeAgent[],
  conflict: ImportConflictStrategy,
  result: ImportDataResult
): void {
  for (const row of rows) {
    const existing = db.prepare("SELECT id FROM runtime_agents WHERE id = ?").get(row.id);
    if (!existing) {
      insertRuntimeAgent(db, row, row.id);
      result.imported++;
      continue;
    }
    if (conflict === "skip") {
      result.skipped++;
      continue;
    }
    if (conflict === "overwrite") {
      updateRuntimeAgent(db, row, row.id);
      result.overwritten++;
      continue;
    }
    insertRuntimeAgent(db, row);
    result.copied++;
  }
}

function importEdges(
  db: DB,
  rows: GraphEdge[],
  sessionMap: Map<string, string>,
  conflict: ImportConflictStrategy,
  result: ImportDataResult
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const from = mapped(sessionMap, row.from);
    const to = mapped(sessionMap, row.to);
    const existing = db
      .prepare("SELECT rowid AS id FROM edges WHERE from_session = ? AND to_session = ?")
      .get(from, to) as { id: number } | undefined;
    if (existing) {
      map.set(row.id, existing.id);
      if (conflict === "skip" || conflict === "copy") {
        result.skipped++;
      } else {
        db.prepare(
          "UPDATE edges SET weight = ?, last_interact_at = ? WHERE rowid = ?"
        ).run(row.weight, row.last_interact_at, existing.id);
        result.overwritten++;
      }
      continue;
    }
    const inserted = db
      .prepare(
        "INSERT INTO edges (from_session, to_session, weight, last_interact_at) VALUES (?, ?, ?, ?)"
      )
      .run(from, to, row.weight, row.last_interact_at);
    map.set(row.id, Number(inserted.lastInsertRowid));
    if (conflict === "copy") result.copied++;
    else result.imported++;
  }
  return map;
}

function importContexts(
  db: DB,
  rows: ContextEntry[],
  sessionMap: Map<string, string>,
  conflict: ImportConflictStrategy,
  result: ImportDataResult
): void {
  for (const row of rows) {
    const existing = db.prepare("SELECT id FROM context_entries WHERE id = ?").get(row.id);
    const sessionId = mapped(sessionMap, row.session_id);
    if (existing) {
      if (conflict === "skip") result.skipped++;
      else if (conflict === "overwrite") {
        updateContext(db, row, row.id, sessionId);
        result.overwritten++;
      } else {
        insertContext(db, row, sessionId);
        result.copied++;
      }
      continue;
    }
    insertContext(db, row, sessionId, row.id);
    if (conflict === "copy") result.copied++;
    else result.imported++;
  }
}

function importConversations(
  db: DB,
  rows: Conversation[],
  sessionMap: Map<string, string>,
  agentMap: Map<number, number>,
  conflict: ImportConflictStrategy,
  result: ImportDataResult
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const agentId = mapped(agentMap, row.agent_id);
    const initiatedBy = row.initiated_by === null
      ? null
      : sessionMap.get(row.initiated_by) ?? row.initiated_by;
    const existing = db.prepare("SELECT id FROM conversations WHERE id = ?").get(row.id);
    if (!existing) {
      const id = insertConversation(db, row, agentId, initiatedBy, row.id);
      map.set(row.id, id);
      if (conflict === "copy") result.copied++;
      else result.imported++;
      continue;
    }
    if (conflict === "skip") {
      map.set(row.id, row.id);
      result.skipped++;
    } else if (conflict === "overwrite") {
      updateConversation(db, row, row.id, agentId, initiatedBy);
      map.set(row.id, row.id);
      result.overwritten++;
    } else {
      const id = insertConversation(db, row, agentId, initiatedBy);
      map.set(row.id, id);
      result.copied++;
    }
  }
  return map;
}

function importTurns(
  db: DB,
  rows: Turn[],
  conversationMap: Map<number, number>,
  conflict: ImportConflictStrategy,
  result: ImportDataResult
): void {
  for (const row of rows) {
    const conversationId = mapped(conversationMap, row.conversation_id);
    const existing = db.prepare("SELECT id FROM turns WHERE id = ?").get(row.id);
    if (!existing) {
      insertTurn(db, row, conversationId, row.id);
      if (conflict === "copy") result.copied++;
      else result.imported++;
    } else if (conflict === "skip") {
      result.skipped++;
    } else if (conflict === "overwrite") {
      db.prepare(
        "UPDATE turns SET conversation_id = ?, role = ?, content = ?, created_at = ? WHERE id = ?"
      ).run(conversationId, row.role, row.content, row.created_at, row.id);
      result.overwritten++;
    } else {
      insertTurn(db, row, conversationId);
      result.copied++;
    }
  }
}

function importMessages(
  db: DB,
  rows: Message[],
  sessionMap: Map<string, string>,
  edgeMap: Map<number, number>,
  conflict: ImportConflictStrategy,
  result: ImportDataResult
): void {
  for (const row of rows) {
    const from = mapped(sessionMap, row.from_session);
    const to = mapped(sessionMap, row.to_session);
    const edgeId = row.edge_id === null ? null : mapped(edgeMap, row.edge_id);
    const existing = db.prepare("SELECT id FROM messages WHERE id = ?").get(row.id);
    if (!existing) {
      insertMessage(db, row, from, to, edgeId, row.id);
      if (conflict === "copy") result.copied++;
      else result.imported++;
    } else if (conflict === "skip") {
      result.skipped++;
    } else if (conflict === "overwrite") {
      updateMessage(db, row, row.id, from, to, edgeId);
      result.overwritten++;
    } else {
      insertMessage(db, row, from, to, edgeId);
      result.copied++;
    }
  }
}

function insertSession(db: DB, row: Session, id: string): void {
  db.prepare(
    `INSERT INTO sessions (
       id, name, description, project_dir, status, created_at, last_heartbeat_at,
       metadata, runtime, identity_source, runtime_pid
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    row.name,
    row.description,
    row.project_dir,
    row.status,
    row.created_at,
    row.last_heartbeat_at,
    row.metadata,
    row.runtime,
    row.identity_source,
    row.runtime_pid
  );
}

function updateSession(db: DB, row: Session, id: string): void {
  db.prepare(
    `UPDATE sessions SET name = ?, description = ?, project_dir = ?, status = ?,
       created_at = ?, last_heartbeat_at = ?, metadata = ?, runtime = ?,
       identity_source = ?, runtime_pid = ? WHERE id = ?`
  ).run(
    row.name,
    row.description,
    row.project_dir,
    row.status,
    row.created_at,
    row.last_heartbeat_at,
    row.metadata,
    row.runtime,
    row.identity_source,
    row.runtime_pid,
    id
  );
}

function insertAgent(db: DB, row: Agent, id?: number): number {
  const result = id === undefined
    ? db
        .prepare(
          `INSERT INTO agents (name, system_prompt, model_config, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(row.name, row.system_prompt, JSON.stringify(row.model_config), row.description, row.created_at, row.updated_at)
    : db
        .prepare(
          `INSERT INTO agents (id, name, system_prompt, model_config, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, row.name, row.system_prompt, JSON.stringify(row.model_config), row.description, row.created_at, row.updated_at);
  return Number(result.lastInsertRowid);
}

function insertAgentCopy(db: DB, row: Agent, sourceIds: Set<number>): number {
  let id = nextAgentId(db);
  while (
    sourceIds.has(id) ||
    db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id) ||
    db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(`agent-${id}`)
  ) {
    id++;
  }
  return insertAgent(db, row, id);
}

function nextAgentId(db: DB): number {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM agents").get() as {
    id: number;
  };
  return row.id;
}

function updateAgent(db: DB, row: Agent, id: number): void {
  db.prepare(
    `UPDATE agents SET name = ?, system_prompt = ?, model_config = ?, description = ?,
       created_at = ?, updated_at = ? WHERE id = ?`
  ).run(row.name, row.system_prompt, JSON.stringify(row.model_config), row.description, row.created_at, row.updated_at, id);
}

function insertRuntimeAgent(db: DB, row: ExportedRuntimeAgent, id?: number): number {
  const values = [
    row.name,
    row.runtime,
    row.workdir,
    row.model,
    row.base_url,
    null,
    row.extra_env,
    row.instructions,
    row.interval_min,
    row.last_scheduled_run,
    row.created_at,
    row.updated_at,
  ];
  const result = id === undefined
    ? db
        .prepare(
          `INSERT INTO runtime_agents
             (name, runtime, workdir, model, base_url, api_key, extra_env, instructions,
              interval_min, last_scheduled_run, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...values)
    : db
        .prepare(
          `INSERT INTO runtime_agents
             (id, name, runtime, workdir, model, base_url, api_key, extra_env, instructions,
              interval_min, last_scheduled_run, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ...values);
  return Number(result.lastInsertRowid);
}

function updateRuntimeAgent(db: DB, row: ExportedRuntimeAgent, id: number): void {
  db.prepare(
    `UPDATE runtime_agents SET name = ?, runtime = ?, workdir = ?, model = ?, base_url = ?,
       extra_env = ?, instructions = ?, interval_min = ?, last_scheduled_run = ?,
       created_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    row.name,
    row.runtime,
    row.workdir,
    row.model,
    row.base_url,
    row.extra_env,
    row.instructions,
    row.interval_min,
    row.last_scheduled_run,
    row.created_at,
    row.updated_at,
    id
  );
}

function insertContext(db: DB, row: ContextEntry, sessionId: string, id?: number): void {
  const values = [
    sessionId,
    row.title,
    row.content,
    row.tags === null ? null : JSON.stringify(row.tags),
    row.created_at,
    row.updated_at,
  ];
  if (id === undefined) {
    db.prepare(
      `INSERT INTO context_entries (session_id, title, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(...values);
    return;
  }
  db.prepare(
    `INSERT INTO context_entries (id, session_id, title, content, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ...values);
}

function updateContext(db: DB, row: ContextEntry, id: number, sessionId: string): void {
  db.prepare(
    `UPDATE context_entries SET session_id = ?, title = ?, content = ?, tags = ?,
       created_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    sessionId,
    row.title,
    row.content,
    row.tags === null ? null : JSON.stringify(row.tags),
    row.created_at,
    row.updated_at,
    id
  );
}

function insertConversation(
  db: DB,
  row: Conversation,
  agentId: number,
  initiatedBy: string | null,
  id?: number
): number {
  const values = [agentId, initiatedBy, row.title, row.created_at, row.updated_at];
  const result = id === undefined
    ? db
        .prepare(
          `INSERT INTO conversations (agent_id, initiated_by, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(...values)
    : db
        .prepare(
          `INSERT INTO conversations (id, agent_id, initiated_by, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, ...values);
  return Number(result.lastInsertRowid);
}

function updateConversation(
  db: DB,
  row: Conversation,
  id: number,
  agentId: number,
  initiatedBy: string | null
): void {
  db.prepare(
    `UPDATE conversations SET agent_id = ?, initiated_by = ?, title = ?, created_at = ?,
       updated_at = ? WHERE id = ?`
  ).run(agentId, initiatedBy, row.title, row.created_at, row.updated_at, id);
}

function insertTurn(db: DB, row: Turn, conversationId: number, id?: number): void {
  if (id === undefined) {
    db.prepare(
      "INSERT INTO turns (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)"
    ).run(conversationId, row.role, row.content, row.created_at);
    return;
  }
  db.prepare(
    "INSERT INTO turns (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, conversationId, row.role, row.content, row.created_at);
}

function insertMessage(
  db: DB,
  row: Message,
  from: string,
  to: string,
  edgeId: number | null,
  id?: number
): number {
  const values = [from, to, row.question, row.reply, row.status, row.created_at, row.replied_at, edgeId];
  const result = id === undefined
    ? db
        .prepare(
          `INSERT INTO messages
             (from_session, to_session, question, reply, status, created_at, replied_at, edge_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...values)
    : db
        .prepare(
          `INSERT INTO messages
             (id, from_session, to_session, question, reply, status, created_at, replied_at, edge_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ...values);
  return Number(result.lastInsertRowid);
}

function updateMessage(
  db: DB,
  row: Message,
  id: number,
  from: string,
  to: string,
  edgeId: number | null
): void {
  db.prepare(
    `UPDATE messages SET from_session = ?, to_session = ?, question = ?, reply = ?,
       status = ?, created_at = ?, replied_at = ?, edge_id = ? WHERE id = ?`
  ).run(from, to, row.question, row.reply, row.status, row.created_at, row.replied_at, edgeId, id);
}

function copyId(db: DB, table: string, original: string): string {
  let candidate = `${original}-copy-${randomUUID()}`;
  while (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(candidate)) {
    candidate = `${original}-copy-${randomUUID()}`;
  }
  return candidate;
}

function canonicalAgentSessionId(
  sessionId: string,
  agentMap: Map<number, number>
): string | null {
  const match = /^agent-(\d+)$/.exec(sessionId);
  if (!match) return null;
  const sourceAgentId = Number(match[1]);
  const targetAgentId = agentMap.get(sourceAgentId);
  return targetAgentId === undefined ? null : `agent-${targetAgentId}`;
}

function mapped<K, V>(map: Map<K, V>, value: K): V {
  const result = map.get(value);
  if (result === undefined) throw new Error(`import mapping missing for ${String(value)}`);
  return result;
}

function assertUnique<T>(values: T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label} in data bundle`);
}

function assertReference<T>(values: Set<T>, value: T, label: string): void {
  if (!values.has(value)) throw new Error(`invalid data bundle reference at ${label}`);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function parseModelConfig(value: string): Agent["model_config"] {
  const parsed = modelConfigSchema.safeParse(parseObject(value, "agent model_config"));
  if (!parsed.success) throw new Error("invalid agent model_config");
  return parsed.data;
}

function parseStringArray(value: string, label: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("not a string array");
    }
    return parsed;
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function isProjectSession(session: Session, projectDir?: string): boolean {
  return isProjectPath(session.project_dir, projectDir);
}

function isProjectPath(value: string | null | undefined, projectDir?: string): boolean {
  if (!value) return false;
  const target = projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return normalizePath(value) === normalizePath(target);
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, "").toLowerCase();
}
