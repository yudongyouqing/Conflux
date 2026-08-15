import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb, type DB } from "../core/db.js";

/**
 * Fresh isolated database per test file. Each file runs in its own process
 * (node:test), so no cross-contamination. Cleanup closes the handle and
 * removes the temp dir (WAL files included) via fs, not shell.
 */
export function makeDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "muiltchat-test-"));
  const db = openDb({
    dataDir: dir,
    dbPath: join(dir, "data.db"),
    scope: "global",
  });
  return {
    db,
    cleanup: () => {
      try {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows WAL locks can linger briefly; temp dir is disposable.
      }
    },
  };
}
