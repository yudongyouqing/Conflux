import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DB } from "./db.js";
import { exportData } from "./data-transfer.js";

/**
 * Category-scoped clearing of Conflux's local "copies": session nodes,
 * cross-session messages and published context notes are all derived from
 * the source conversations (Claude Code / Codex transcripts), so clearing
 * them loses nothing original. A full data bundle is always exported before
 * anything is deleted, and old backups rotate (issue #79).
 *
 * Never touched: runtime agent presets and app settings (except the
 * orphaned claude-current:<pid> markers when their sessions are cleared).
 * The built-in `web-console` session row always survives.
 */

export interface ClearableCounts {
  sessions: number;
  messages: number;
  contextEntries: number;
}

export interface ClearCategories {
  sessions?: boolean;
  messages?: boolean;
  context?: boolean;
}

export interface ClearResult {
  /** Backup bundle written before deletion; null when nothing was selected. */
  backupPath: string | null;
  cleared: ClearableCounts;
}

/** How many clear-backup-*.json files to keep in the backup dir. */
export const CLEAR_BACKUP_KEEP = 5;

function count(db: DB, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

export function getClearableCounts(db: DB): ClearableCounts {
  return {
    sessions: count(db, "SELECT COUNT(*) AS n FROM sessions WHERE id != 'web-console'"),
    messages: count(db, "SELECT COUNT(*) AS n FROM messages"),
    contextEntries: count(db, "SELECT COUNT(*) AS n FROM context_entries"),
  };
}

/** Keep only the newest CLEAR_BACKUP_KEEP clear-backup files in dir. */
export function rotateBackups(backupDir: string): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith("clear-backup-") && f.endsWith(".json"))
    .map((f) => {
      const p = join(backupDir, f);
      try {
        return { p, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { p: string; mtimeMs: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(CLEAR_BACKUP_KEEP)) {
    try {
      // Windows: AV / search indexer can briefly hold a freshly written
      // file (ERROR_SHARING_VIOLATION → EBUSY). rmSync retries those
      // natively; force covers already-gone.
      rmSync(f.p, { force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // still locked after retries — leave it for the next rotation; the
      // deletion itself already happened and must not fail the clear
    }
  }
}

export function clearData(
  db: DB,
  categories: ClearCategories,
  backupDir: string,
): ClearResult {
  if (!categories.sessions && !categories.messages && !categories.context) {
    return { backupPath: null, cleared: { sessions: 0, messages: 0, contextEntries: 0 } };
  }
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `clear-backup-${stamp}.json`);
  const result = clearDataToPath(db, categories, backupPath);
  rotateBackups(backupDir);
  return result;
}

/**
 * Atomic clear: the backup SNAPSHOT, the backup FILE and the deletes run
 * in ONE immediate transaction. BEGIN IMMEDIATE takes the write lock
 * before the snapshot, so no other connection can commit between what the
 * backup contains and what the deletes remove — everything deleted is in
 * the backup, including rows committed while an earlier attempt was
 * waiting on the lock, and sessions-level cascade victims (their messages
 * and contexts are plain rows at snapshot time).
 *
 * The backup path is decided by the CALLER, once per clear request: a
 * retried transaction overwrites the same file with the snapshot of the
 * attempt that actually commits — the file operation is idempotent, never
 * a per-retry duplicate stamp. The file is written before the deletes
 * inside the transaction, so a rollback that discards the deletes also
 * discards the need for the backup; the committing attempt's file is
 * exactly the pre-delete state it removes.
 */
export function clearDataToPath(
  db: DB,
  categories: ClearCategories,
  backupPath: string,
): ClearResult {
  if (!categories.sessions && !categories.messages && !categories.context) {
    return { backupPath: null, cleared: { sessions: 0, messages: 0, contextEntries: 0 } };
  }
  return db
    .transaction(() => {
      const snapshot = exportData(db);
      // mkdir is idempotent; the same path is overwritten on a retry.
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), "utf8");
      const before = getClearableCounts(db);
      applyDeletes(db, categories);
      const after = getClearableCounts(db);
      return {
        backupPath,
        cleared: {
          sessions: before.sessions - after.sessions,
          messages: before.messages - after.messages,
          contextEntries: before.contextEntries - after.contextEntries,
        },
      };
    })
    .immediate();
}

function applyDeletes(db: DB, categories: ClearCategories): void {
  if (categories.messages) db.prepare("DELETE FROM messages").run();
  if (categories.context) db.prepare("DELETE FROM context_entries").run();
  if (categories.sessions) {
    // FK cascade (foreign_keys = ON) wipes each session's messages and
    // context entries; edges carry no FK, so orphaned ones go manually.
    db.prepare("DELETE FROM sessions WHERE id != 'web-console'").run();
    db.prepare(
      `DELETE FROM edges WHERE from_session NOT IN (SELECT id FROM sessions)
        OR to_session NOT IN (SELECT id FROM sessions)`,
    ).run();
    // pid → conversation markers now point at nothing
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'claude-current:%'").run();
  }
}

