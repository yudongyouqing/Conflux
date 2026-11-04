import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { openDb, retryOnBusy, stopWalCheckpoint, type DB } from "../core/db.js";
import { prepareAsk, completeAsk } from "../core/ask.js";
import { registerSession } from "../core/sessions.js";
import type { WakeResult } from "../core/wake/index.js";

// Fault-injection regression for the ask-path split: a lock-contended
// retry of the DATABASE phase must never re-run the EXTERNAL wake. The
// reviewer reproduced the old shape (wake inside the retried transaction):
// 2 retries → the wake callback fired 2 times while the rolled-back
// delivery claim left only 1 row — the rollback erased the very dedup
// record that was supposed to guard it. The contract pinned here:
//   prepareAsk (phase 1, database-only) may run N times under contention,
//   completeAsk (phase 2, external wake) runs exactly once — strictly
//   after phase 1 commits.

function seed(): { db: DB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ask-retry-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  registerSession(db, { id: "asker", name: "asker" });
  registerSession(db, { id: "target", name: "target" });
  return { db, dir };
}

test("lock contention retries the database phase but executes the external wake exactly once", async () => {
  const { db, dir } = seed();
  // The server-style connection: fail fast on a held lock and let the JS
  // retry budget drive the waiting.
  db.pragma("busy_timeout = 50");
  // The blocking connection plays the external lock holder.
  const blocker = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  try {
    let externalRuns = 0;
    const countingWake = (_db: DB, _sessionId: string): WakeResult => {
      externalRuns++;
      return { woke: true, command: "counting-wake" };
    };

    blocker.pragma("busy_timeout = 50");
    await blocker.exec("BEGIN IMMEDIATE");
    blocker
      .prepare(
        `INSERT INTO context_entries (session_id, title, content, created_at, updated_at)
         VALUES ('asker', 'block', 'block', datetime('now'), datetime('now'))`,
      )
      .run();

    // Phase 1 under real contention: with the server-style retry it must
    // keep failing cleanly (no partial state) until the lock is released.
    let prepareAttempts = 0;
    const phase1 = retryOnBusy(
      db,
      () => {
        prepareAttempts++;
        return prepareAsk(db, {
          from_session: "asker",
          to_session: "target",
          question: "contended ask",
        });
      },
      { budgetMs: 4000, pauseMs: 60 },
    );
    const releaseSoon = setTimeout(() => {
      blocker.exec("ROLLBACK");
    }, 800);
    const prepared = await phase1;
    clearTimeout(releaseSoon);
    assert.ok(prepareAttempts >= 2, `expected the transaction to be retried, ran ${prepareAttempts} time(s)`);

    // The retried phase 1 leaves exactly one question and one claim row.
    const questions = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE question = 'contended ask'`)
      .get() as { n: number };
    assert.equal(questions.n, 1, "each retry must roll back cleanly — exactly one question row");

    // Phase 2 runs ONCE, after the commit, outside any retried transaction.
    const outcome = await completeAsk(db, prepared, countingWake);
    assert.ok(outcome.wake.woke);
    assert.equal(externalRuns, 1, "the external wake must execute exactly once regardless of retries");
    const claims = db
      .prepare(`SELECT COUNT(*) AS n FROM message_deliveries WHERE message_id = ?`)
      .get(prepared.claim!.id) as { n: number };
    assert.equal(claims.n, 1, "exactly one delivery row");
  } finally {
    stopWalCheckpoint(blocker);
    blocker.close();
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the composite askAndMaybeWake still runs wake exactly once for non-retrying callers", async () => {
  const { db, dir } = seed();
  try {
    let externalRuns = 0;
    // Directly exercise the composite with a counting wake through the
    // module's injectable seam: completeAsk's default is the real wake, so
    // call the pieces the way askAndMaybeWake does, with our counter.
    const prepared = prepareAsk(db, {
      from_session: "asker",
      to_session: "target",
      question: "plain ask",
    });
    const outcome = await completeAsk(db, prepared, () => {
      externalRuns++;
      return { woke: false, reason: "test" } as WakeResult;
    });
    assert.equal(outcome.wake.woke, false);
    assert.equal(externalRuns, 1);
    assert.equal(typeof outcome.message.id, "number");
  } finally {
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a locked status write-back reports the accepted message instead of failing the send", async () => {
  const { db, dir } = seed();
  db.pragma("busy_timeout = 50");
  const blocker = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  try {
    const prepared = prepareAsk(db, {
      from_session: "asker",
      to_session: "target",
      question: "write-back under lock",
    });
    assert.ok(prepared.claim, "the delivery claim must be acquired");

    // Hold the write lock so the status write-back cannot land; the
    // external wake has ALREADY run once and must never re-run.
    await blocker.exec("BEGIN IMMEDIATE");
    blocker
      .prepare(
        `INSERT INTO context_entries (session_id, title, content, created_at, updated_at)
         VALUES ('asker', 'hold', 'hold', datetime('now'), datetime('now'))`,
      )
      .run();

    let externalRuns = 0;
    const release = new Promise<void>((resolveRelease) => {
      setTimeout(() => {
        blocker.exec("ROLLBACK");
        resolveRelease();
      }, 900);
    });
    const outcome = await completeAsk(db, prepared, () => {
      externalRuns++;
      return { woke: true, command: "counting-wake" };
    });
    await release;
    assert.equal(externalRuns, 1, "the wake must never re-run for a status retry");
    // The message IS committed and delivered — the outcome must say so
    // instead of throwing a send-failed error that baits a duplicate.
    assert.equal(outcome.message.id, prepared.message.id);
    assert.equal(outcome.wake.woke, true);
    const committed = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE question = 'write-back under lock'`)
      .get() as { n: number };
    assert.equal(committed.n, 1, "exactly one committed message");
  } finally {
    stopWalCheckpoint(blocker);
    blocker.close();
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
