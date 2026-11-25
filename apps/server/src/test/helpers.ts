import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";

/**
 * Fresh isolated v2 database (`conflux-v2.db`) per test file.
 */
export function makeDb(): { db: DB; dataDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "conflux-v2-test-"));
  const db = openDb({
    dataDir: dir,
    dbPath: join(dir, "conflux-v2.db"),
    scope: "global",
  });
  return {
    db,
    dataDir: dir,
    cleanup: () => {
      try {
        stopWalCheckpoint(db);
        if (db.open) db.close();
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Windows WAL locks can linger briefly; temp dir is disposable.
      }
    },
  };
}
