import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import type { Config } from "../config.js";
import { logger } from "../log.js";

export type DB = Database.Database;

export type PublicErrorCode =
  | "DATA_LOCKED"
  | "DATA_CORRUPT"
  | "PORT_IN_USE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface PublicError {
  code: PublicErrorCode;
  message: string;
}

export interface PublicErrorContext {
  dataDir?: string;
  port?: number;
}

export const SCHEMA_VERSION = 23;
export const BUSY_TIMEOUT_MS = 5000;
export const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
export const WAL_CHECKPOINT_THRESHOLD_BYTES = 10 * 1024 * 1024;

const checkpointTimers = new WeakMap<DB, NodeJS.Timeout>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safePublicMessage(value: string, fallback: string): string {
  const message = value.trim();
  if (!message || message.length > 500) return fallback;
  return message;
}

export function isLockError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const rawCode = typeof error.code === "string" ? error.code : "";
  if (/^SQLITE_(BUSY|LOCKED)/.test(rawCode)) return true;
  const rawMessage = typeof error.message === "string" ? error.message : "";
  return /\bdatabase is locked\b/i.test(rawMessage);
}

export async function retryOnBusy<T>(
  _db: DB,
  op: () => T,
  opts: { budgetMs?: number; pauseMs?: number } = {},
): Promise<T> {
  const budgetMs = opts.budgetMs ?? BUSY_TIMEOUT_MS;
  const pauseMs = opts.pauseMs ?? 25;
  const startedAt = Date.now();
  for (;;) {
    try {
      return op();
    } catch (error) {
      if (!isLockError(error) || Date.now() - startedAt >= budgetMs) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

export function publicError(error: unknown, context: PublicErrorContext = {}): PublicError {
  const value = isRecord(error) ? error : {};
  const rawCode = typeof value.code === "string" ? value.code : "";
  const rawStatus = typeof value.statusCode === "number" ? value.statusCode : undefined;
  const rawMessage = typeof value.message === "string" ? value.message : String(error ?? "");
  const code = rawCode || (rawMessage.match(/\b(SQLITE_[A-Z_]+|EADDRINUSE)\b/)?.[1] ?? "");

  if (/^SQLITE_(BUSY|LOCKED)/.test(code)) {
    return {
      code: "DATA_LOCKED",
      message: "数据库正在被另一个进程使用，请稍后重试或关闭重复的 Conflux 实例。",
    };
  }
  if (/^SQLITE_(CORRUPT|NOTADB)/.test(code)) {
    return {
      code: "DATA_CORRUPT",
      message:
        "数据库文件可能已损坏，请先停止 Conflux 并检查数据目录。" +
        (context.dataDir ? ` 数据目录：${context.dataDir}` : ""),
    };
  }
  if (code === "EADDRINUSE") {
    return {
      code: "PORT_IN_USE",
      message: `端口 ${context.port ?? "9527"} 已被其他进程占用，请关闭重复的 Conflux 实例后重试。`,
    };
  }
  if (rawStatus === 429) {
    return {
      code: "TOO_MANY_REQUESTS",
      message: safePublicMessage(rawMessage, "触发自主协作护栏限制，请稍候或由人工确认。"),
    };
  }
  if (rawStatus === 404 || /\bnot found\b/i.test(rawMessage)) {
    return { code: "NOT_FOUND", message: safePublicMessage(rawMessage, "请求的资源不存在。") };
  }
  if (rawStatus === 409 || /^SQLITE_CONSTRAINT/.test(code)) {
    return { code: "CONFLICT", message: safePublicMessage(rawMessage, "请求与现有数据冲突。") };
  }
  if (rawStatus === 403 || /not owner|not the addressee/i.test(rawMessage)) {
    return { code: "FORBIDDEN", message: safePublicMessage(rawMessage, "无权执行此操作。") };
  }
  if (
    rawStatus === 400 ||
    rawStatus === 422 ||
    /\bmissing\b|cannot ask yourself|must be /i.test(rawMessage)
  ) {
    return { code: "BAD_REQUEST", message: safePublicMessage(rawMessage, "请求参数无效。") };
  }
  if (rawStatus === 503) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: safePublicMessage(rawMessage, "服务暂时不可用，请稍后重试。"),
    };
  }
  return { code: "INTERNAL_ERROR", message: "服务器内部错误，请查看日志。" };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  root_path      TEXT NOT NULL UNIQUE,
  default_branch TEXT,
  is_git_repo    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_threads (
  id                     TEXT PRIMARY KEY,
  project_id             INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name                   TEXT NOT NULL,
  kind                   TEXT NOT NULL DEFAULT 'managed',
  runtime                TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'idle',
  approval_mode          TEXT NOT NULL DEFAULT 'ask',
  incoming_call_mode     TEXT NOT NULL DEFAULT 'auto',
  host                   TEXT NOT NULL DEFAULT 'localhost',
  workdir                TEXT NOT NULL,
  worktree_path          TEXT,
  worktree_branch        TEXT,
  base_branch            TEXT,
  pr_url                 TEXT,
  preview_url            TEXT,
  external_session_id    TEXT,
  model                  TEXT,
  instructions           TEXT,
  extra_env              TEXT,
  provider_thread_id     TEXT,
  owner_token            TEXT,
  active_turn_id         TEXT,
  pid                    INTEGER,
  mica_pane_id           INTEGER,
  parent_thread_id       TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
  last_synced_context_id INTEGER NOT NULL DEFAULT 0,
  last_seen_at           TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON agent_threads(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_workdir ON agent_threads(workdir, state);
CREATE INDEX IF NOT EXISTS idx_threads_kind_state ON agent_threads(kind, state);

CREATE TABLE IF NOT EXISTS agent_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  runtime       TEXT NOT NULL,
  model         TEXT,
  instructions  TEXT,
  extra_env     TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'ask',
  use_worktree  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  run_id     INTEGER,
  ref_name   TEXT NOT NULL,
  tree_sha   TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  summary    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON thread_checkpoints(thread_id, id DESC);

CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_project ON rooms(project_id, id DESC);

CREATE TABLE IF NOT EXISTS room_members (
  room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_room_members_thread ON room_members(thread_id);

CREATE TABLE IF NOT EXISTS edges (
  from_thread      TEXT NOT NULL,
  to_thread        TEXT NOT NULL,
  weight           INTEGER NOT NULL DEFAULT 1,
  last_interact_at TEXT NOT NULL,
  PRIMARY KEY (from_thread, to_thread)
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_id      INTEGER,
  from_thread  TEXT NOT NULL,
  to_thread    TEXT NOT NULL,
  question     TEXT NOT NULL,
  context      TEXT,
  reply        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  room_id      INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  trace_id     TEXT,
  hop_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  replied_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_thread, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_thread, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id ASC);

CREATE TABLE IF NOT EXISTS room_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id             INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  initiator_thread_id TEXT NOT NULL,
  executor_thread_id  TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  summary             TEXT,
  message_id          INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_tasks_room ON room_tasks(room_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_room_tasks_message ON room_tasks(message_id);

CREATE TABLE IF NOT EXISTS thread_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  message_id    INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  room_id       INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  prompt        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'queued',
  turn_id       TEXT,
  final_text    TEXT,
  error_code    TEXT,
  checkpoint_id INTEGER REFERENCES thread_checkpoints(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_runs_thread_state ON thread_runs(thread_id, state, id);

CREATE TABLE IF NOT EXISTS thread_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id    TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  run_id       INTEGER REFERENCES thread_runs(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_events_thread ON thread_events(thread_id, seq);

CREATE TABLE IF NOT EXISTS thread_approvals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id      TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  run_id         INTEGER NOT NULL REFERENCES thread_runs(id) ON DELETE CASCADE,
  rpc_request_id TEXT NOT NULL,
  kind           TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending',
  decision       TEXT,
  response_json  TEXT,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_thread_approvals_state ON thread_approvals(state, id);
CREATE INDEX IF NOT EXISTS idx_thread_approvals_run ON thread_approvals(run_id, state);

CREATE TABLE IF NOT EXISTS context_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  room_id    INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'note',
  pinned     INTEGER NOT NULL DEFAULT 0,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_project ON context_entries(project_id, pinned DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_context_room ON context_entries(room_id, pinned DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_context_thread ON context_entries(thread_id, id DESC);

CREATE TABLE IF NOT EXISTS workflows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  room_id     INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  steps_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_id, id DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  room_id      INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  input        TEXT,
  initiated_by TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id, id DESC);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'agent',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  target_thread_id TEXT,
  prompt_template TEXT NOT NULL DEFAULT '',
  include_handoff INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  output          TEXT,
  error           TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  UNIQUE(run_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(run_id, id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_msg ON workflow_steps(message_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  caller_session TEXT,
  interface      TEXT NOT NULL,
  action         TEXT NOT NULL,
  args           TEXT,
  result         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
`;

export function openDb(config: Config): DB {
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const current = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (current < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL);
    const threadCols = new Set(
      (db.pragma("table_info(agent_threads)") as Array<{ name: string }>).map((c) => c.name),
    );
    if (!threadCols.has("pr_url")) {
      db.exec(`ALTER TABLE agent_threads ADD COLUMN pr_url TEXT`);
    }
    if (!threadCols.has("incoming_call_mode")) {
      db.exec(`ALTER TABLE agent_threads ADD COLUMN incoming_call_mode TEXT NOT NULL DEFAULT 'auto'`);
    }
    if (!threadCols.has("host")) {
      db.exec(`ALTER TABLE agent_threads ADD COLUMN host TEXT NOT NULL DEFAULT 'localhost'`);
    }
    if (!threadCols.has("preview_url")) {
      db.exec(`ALTER TABLE agent_threads ADD COLUMN preview_url TEXT`);
    }
    if (!threadCols.has("external_session_id")) {
      db.exec(`ALTER TABLE agent_threads ADD COLUMN external_session_id TEXT`);
    }
    if (!threadCols.has("mica_pane_id")) {
      db.exec(`ALTER TABLE agent_threads ADD COLUMN mica_pane_id INTEGER`);
    }
    const msgCols = new Set(
      (db.pragma("table_info(messages)") as Array<{ name: string }>).map((c) => c.name),
    );
    if (!msgCols.has("context")) {
      db.exec(`ALTER TABLE messages ADD COLUMN context TEXT`);
    }
    if (!msgCols.has("trace_id")) {
      db.exec(`ALTER TABLE messages ADD COLUMN trace_id TEXT`);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    logger.info({ from: current, to: SCHEMA_VERSION, dbPath: config.dbPath }, "conflux v2 db initialized");
  }

  scheduleWalCheckpoint(db, config.dbPath);
  return db;
}

export function walFileSize(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  if (!existsSync(walPath)) return 0;
  try {
    return statSync(walPath).size;
  } catch {
    return 0;
  }
}

export function maybeCheckpointWal(
  db: DB,
  dbPath: string,
  thresholdBytes = WAL_CHECKPOINT_THRESHOLD_BYTES,
): boolean {
  if (!db.open || dbPath === ":memory:") return false;
  const walBytes = walFileSize(dbPath);
  if (walBytes < thresholdBytes) return false;
  try {
    const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    logger.info({ walBytes, result: result[0] ?? null }, "wal checkpointed");
    return true;
  } catch (err) {
    logger.warn({ err, walBytes }, "wal checkpoint skipped");
    return false;
  }
}

export function scheduleWalCheckpoint(
  db: DB,
  dbPath: string,
  opts: { intervalMs?: number; thresholdBytes?: number } = {},
): void {
  if (dbPath === ":memory:") return;
  stopWalCheckpoint(db);
  const timer = setInterval(() => {
    if (!db.open) {
      stopWalCheckpoint(db);
      return;
    }
    maybeCheckpointWal(db, dbPath, opts.thresholdBytes);
  }, opts.intervalMs ?? WAL_CHECKPOINT_INTERVAL_MS);
  timer.unref();
  checkpointTimers.set(db, timer);
}

export function stopWalCheckpoint(db: DB): void {
  const timer = checkpointTimers.get(db);
  if (timer) {
    clearInterval(timer);
    checkpointTimers.delete(db);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
