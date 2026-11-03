import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { openDb, retryOnBusy, stopWalCheckpoint } from "../core/db.js";
import { clearDataToPath } from "../core/data-clear.js";
import { importData } from "../core/data-transfer.js";
import { registerSession } from "../core/sessions.js";
import { askSession } from "../core/messages.js";
import { publishContext } from "../core/context.js";

// Regression for the clear-path race: the old flow took the backup
// WITHOUT the write lock and deleted in a later transaction, so rows
// another connection committed in between were deleted but absent from
// the backup (reviewer-reproduced: 2 deleted, 1 backed up). The atomic
// contract pinned here: the snapshot, the backup file and the deletes run
// in ONE immediate transaction — rows committed before the clear's
// transaction began are ALL in the backup; rows committed after it
// commits survive untouched.

test("data committed before the clear transaction is fully in the backup and restorable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clear-race-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  db.pragma("busy_timeout = 50");
  const other = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const backupDir = join(dir, "backups");
  const backupPath = join(backupDir, "clear-backup-race.json");
  try {
    // Seeded data on the main connection.
    registerSession(db, { id: "s1", name: "one" });
    registerSession(db, { id: "s2", name: "two" });
    askSession(db, { from_session: "s1", to_session: "s2", question: "seeded message" });
    publishContext(db, { session_id: "s1", title: "seeded ctx", content: "seeded body" });

    // The "committed while the clear was waiting" rows: another connection
    // commits a second message, THEN holds the write lock so the clear's
    // first attempts contend (exactly the old race window).
    other.pragma("busy_timeout = 50");
    askSession(other, { from_session: "s1", to_session: "s2", question: "committed before clear" });
    await other.exec("BEGIN IMMEDIATE");
    other
      .prepare(
        `INSERT INTO context_entries (session_id, title, content, created_at, updated_at)
         VALUES ('s1', 'uncommitted holder', 'invisible', datetime('now'), datetime('now'))`,
      )
      .run();
    const release = new Promise<void>((resolveRelease) => {
      setTimeout(() => {
        other.exec("ROLLBACK");
        resolveRelease();
      }, 700);
    });

    let attempts = 0;
    const result = await retryOnBusy(
      db,
      () => {
        attempts++;
        return clearDataToPath(db, { sessions: true, messages: true, context: true }, backupPath);
      },
      { budgetMs: 4000, pauseMs: 60 },
    );
    await release;
    assert.ok(attempts >= 2, `expected the clear transaction to be retried, ran ${attempts} time(s)}`);
    assert.ok(result.backupPath);

    // Both committed messages were deleted…
    const messagesAfter = db
      .prepare(`SELECT COUNT(*) AS n FROM messages`)
      .get() as { n: number };
    assert.equal(messagesAfter.n, 0, "all messages removed");
    // …and the backup contains BOTH — the race window is closed.
    const bundle = JSON.parse(readFileSync(backupPath, "utf8")) as {
      messages: { question: string }[];
      context_entries?: { title: string }[];
      contexts?: { title: string }[];
    };
    const questions = bundle.messages.map((m) => m.question).sort();
    assert.deepEqual(
      questions,
      ["committed before clear", "seeded message"],
      "every deleted message must be in the backup, including the concurrently committed one",
    );
    // Cascade coverage: the deleted session's context row is in the backup.
    const contextTitles = [...(bundle.context_entries ?? []), ...(bundle.contexts ?? [])].map(
      (c) => c.title,
    );
    assert.ok(contextTitles.includes("seeded ctx"), "cascade-deleted context must be in the backup");

    // Idempotent file handling: one clear request, one backup file — the
    // retried transaction overwrote the same path, never a second stamp.
    assert.deepEqual(readdirSync(backupDir), ["clear-backup-race.json"]);

    // The backup actually restores everything that was deleted.
    importData(db, bundle as Parameters<typeof importData>[1], { conflict: "overwrite" });
    const restored = db
      .prepare(`SELECT question FROM messages ORDER BY id`)
      .all() as { question: string }[];
    assert.deepEqual(
      restored.map((r) => r.question),
      ["seeded message", "committed before clear"],
      "the backup restores all deleted data",
    );

    // Rows committed AFTER the clear committed survive untouched (covered
    // deterministically by the second test below).
  } finally {
    stopWalCheckpoint(other);
    other.close();
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rows committed after the clear committed survive and are not required in the backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clear-after-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const other = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const backupPath = join(dir, "backups", "clear-backup-after.json");
  try {
    registerSession(db, { id: "a1", name: "a" });
    registerSession(db, { id: "a2", name: "b" });
    askSession(db, { from_session: "a1", to_session: "a2", question: "before" });
    clearDataToPath(db, { messages: true }, backupPath);

    // Committed after the clear: must survive.
    askSession(other, { from_session: "a1", to_session: "a2", question: "after" });
    const survivors = db
      .prepare(`SELECT question FROM messages ORDER BY id`)
      .all() as { question: string }[];
    assert.deepEqual(
      survivors.map((s) => s.question),
      ["after"],
      "post-clear commits survive and were never the backup's responsibility",
    );
    const bundle = JSON.parse(readFileSync(backupPath, "utf8")) as { messages: unknown[] };
    assert.equal(bundle.messages.length, 1, "the backup covers exactly the pre-clear state");
  } finally {
    stopWalCheckpoint(other);
    other.close();
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


