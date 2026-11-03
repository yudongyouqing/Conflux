import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  const backupPath = prepareClearBackup(db, categories, backupDir);
  const cleared = applyClearData(db, categories);
  rotateBackups(backupDir);
  return { backupPath, cleared };
}

/**
 * Phase 1 — EXTERNAL: writes the pre-clear full-bundle backup file (the
 * restore path is the existing /data/import). Runs ONCE, before any
 * retried database phase: a file cannot be rolled back, and a retry that
 * re-ran it would mint duplicate backup stamps. Returns null when no
 * category was selected.
 */
export function prepareClearBackup(
  db: DB,
  categories: ClearCategories,
  backupDir: string,
): string | null {
  if (!categories.sessions && !categories.messages && !categories.context) return null;
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `clear-backup-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(exportData(db), null, 2), "utf8");
  return backupPath;
}

/**
 * Phase 2 — DATABASE ONLY: the category deletes. Safe to retry inside one
 * transaction; a rollback restores the deleted rows and the retry re-runs.
 * Backup rotation (file cleanup) stays with the caller, after the commit.
 */
export function applyClearData(
  db: DB,
  categories: ClearCategories,
): { sessions: number; messages: number; contextEntries: number } {
  if (!categories.sessions && !categories.messages && !categories.context) {
    return { sessions: 0, messages: 0, contextEntries: 0 };
  }
  const before = getClearableCounts(db);

  if (categories.messages) db.prepare("DELETE FROM messages").run();
  if (categories.context) db.prepare("DELETE FROM context_entries").run();
  if (categories.sessions) {
    // FK cascade (foreign_keys = ON) wipes this session's messages and
    // context entries; edges carry no FK, so orphaned ones go manually.
    db.prepare("DELETE FROM sessions WHERE id != 'web-console'").run();
    db.prepare(
      `DELETE FROM edges WHERE from_session NOT IN (SELECT id FROM sessions)
        OR to_session NOT IN (SELECT id FROM sessions)`,
    ).run();
    // pid → conversation markers now point at nothing
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'claude-current:%'").run();
  }

  const after = getClearableCounts(db);
  return {
    sessions: before.sessions - after.sessions,
    messages: before.messages - after.messages,
    contextEntries: before.contextEntries - after.contextEntries,
  };
}
