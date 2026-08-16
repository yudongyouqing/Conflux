import Database from "better-sqlite3";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { Config } from "../config.js";
import { logger } from "../log.js";

export type DB = Database.Database;

const SCHEMA_VERSION = 8;

// Track the checkpoint timer in a module-scoped variable (avoids touching the
// globalThis type signature).
let checkpointTimer: NodeJS.Timeout | null = null;

const SCHEMA_SQL = `
-- schema_version marker (user_version PRAGMA, set separately)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  project_dir TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON sessions(last_heartbeat_at);

CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_context_session ON context_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_context_updated ON context_entries(updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  title,
  content,
  content='',
  tokenize='unicode61'
);

-- Triggers keep context_fts in sync with context_entries.
CREATE TRIGGER IF NOT EXISTS context_ai AFTER INSERT ON context_entries BEGIN
  INSERT INTO context_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS context_ad AFTER DELETE ON context_entries BEGIN
  INSERT INTO context_fts(context_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS context_au AFTER UPDATE ON context_entries BEGIN
  INSERT INTO context_fts(context_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO context_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  question TEXT NOT NULL,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  replied_at TEXT,
  FOREIGN KEY (from_session) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (to_session) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_session, status);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_session, status);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- Graph edges: directed, formed dynamically from communication history.
-- Each ask_session / reply_ask upserts a row (weight + 1).
CREATE TABLE IF NOT EXISTS edges (
  from_session TEXT NOT NULL,
  to_session   TEXT NOT NULL,
  weight       INTEGER NOT NULL DEFAULT 1,
  last_interact_at TEXT NOT NULL,
  PRIMARY KEY (from_session, to_session)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_session);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_session);

-- Internal agent definitions (for the agent runtime).
-- model_config is JSON: { provider, model, temperature?, max_tokens? }
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model_config TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

-- Conversation model for internal agent chats.
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  initiated_by TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id);

-- User-configured runtime agents: presets for spawning real CLI agents
-- (Claude Code / Codex) with a fixed working directory and API channel.
-- api_key is stored locally (single-user local tool). extra_env is a JSON
-- object string of additional environment variables for the spawned process.
CREATE TABLE IF NOT EXISTS runtime_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  workdir TEXT,
  model TEXT,
  base_url TEXT,
  api_key TEXT,
  extra_env TEXT,
  instructions TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Simple KV store for UI/server settings (e.g. terminal opener config).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  caller_session TEXT,
  interface TEXT NOT NULL,
  action TEXT NOT NULL,
  args TEXT,
  result TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(caller_session);
`;

/**
 * Open (or reuse) a single database connection per process.
 * Uses WAL mode for safe multi-process concurrent reads + single writer.
 */
export function openDb(config: Config): DB {
  const db = new Database(config.dbPath);
  db.pragma(`journal_mode = WAL`);
  db.pragma(`busy_timeout = 10000`);
  db.pragma(`synchronous = NORMAL`);
  db.pragma(`foreign_keys = ON`);

  migrate(db);
  scheduleWalCheckpoint(config, db);
  return db;
}

/**
 * Remove edges that never carried a question (from→to) — they were created
 * by the old replyAsk reverse-edge bookkeeping; their content lives in the
 * channel's message replies. Exported for tests.
 */
export function collapseReplyEdges(db: DB): number {
  const res = db
    .prepare(
      `DELETE FROM edges WHERE NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.from_session = edges.from_session AND m.to_session = edges.to_session
       )`
    )
    .run();
  return res.changes;
}

/** Run idempotent schema migrations. */
function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  db.exec(SCHEMA_SQL);
  // CREATE TABLE IF NOT EXISTS cannot extend existing tables — best-effort
  // column additions for DBs created before v7.
  const ensureColumn = (table: string, col: string, ddl: string) => {
    const cols = db.pragma(`table_info(${table})`) as { name: string }[];
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  ensureColumn("runtime_agents", "interval_min", "interval_min INTEGER");
  ensureColumn("runtime_agents", "last_scheduled_run", "last_scheduled_run TEXT");
  // v8: edge-centric channels — messages link to their channel edge, and
  // reply-created reverse edges are collapsed (replies stay on the channel)
  ensureColumn("messages", "edge_id", "edge_id INTEGER");
  db.exec(`
    INSERT OR IGNORE INTO edges (from_session, to_session, weight, last_interact_at)
      SELECT from_session, to_session, COUNT(*), MAX(COALESCE(replied_at, created_at))
      FROM messages GROUP BY from_session, to_session;
    UPDATE messages SET edge_id = (
      SELECT e.rowid FROM edges e
      WHERE e.from_session = messages.from_session AND e.to_session = messages.to_session
    ) WHERE edge_id IS NULL;
  `);
  collapseReplyEdges(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  logger.info({ from: current, to: SCHEMA_VERSION }, "db migrated");
}

/**
 * Schedule a periodic WAL checkpoint monitor. Long-running processes (HTTP server)
 * need this so the WAL file does not grow unbounded. MCP/CLI short-lived processes
 * rely on the default PASSIVE checkpointing that happens during reads.
 */
function scheduleWalCheckpoint(config: Config, db: DB): void {
  const intervalMs = 30_000;
  const walThresholdBytes = 64 * 1024 * 1024;

  if (checkpointTimer) return;
  const timer = setInterval(() => {
    try {
      const walPath = `${config.dbPath}-wal`;
      if (existsSync(walPath)) {
        const size = statSync(walPath).size;
        if (size > walThresholdBytes) {
          const before = Date.now();
          db.pragma("wal_checkpoint(TRUNCATE)");
          logger.debug(
            { walBytesBefore: size, ms: Date.now() - before },
            "wal checkpoint triggered"
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "wal checkpoint monitor error");
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  checkpointTimer = timer;
}

export function nowIso(): string {
  return new Date().toISOString();
}
