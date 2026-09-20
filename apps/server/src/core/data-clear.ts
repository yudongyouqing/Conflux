import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
function rotateBackups(backupDir: string): void {
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
      unlinkSync(f.p);
    } catch {
      // already gone — fine
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

  // Full bundle first — the restore path is the existing /data/import.
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `clear-backup-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(exportData(db), null, 2), "utf8");

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
  rotateBackups(backupDir);

  return {
    backupPath,
    cleared: {
      sessions: before.sessions - after.sessions,
      messages: before.messages - after.messages,
      contextEntries: before.contextEntries - after.contextEntries,
    },
  };
}
