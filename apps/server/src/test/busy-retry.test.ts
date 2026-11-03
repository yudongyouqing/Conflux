import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { openDb, retryOnBusy, stopWalCheckpoint, BUSY_TIMEOUT_MS } from "../core/db.js";

// retryOnBusy drives the HTTP server's busy budget with the event loop
// yielded between attempts. These regressions pin the contract:
//  - lock-family errors retry until the budget is spent, then rethrow;
//  - non-lock errors propagate immediately;
//  - a lock error mid-closure rolls the whole immediate transaction back,
//    so the retry re-runs the closure exactly once-per-commit (no partial
//    writes, no duplicated audits);
//  - the budget equals the documented production busy timeout.

test("retryOnBusy retries lock errors, yields, and rethrows after the budget", async () => {
  let attempts = 0;

  const db = { transaction: null } as never;
  const start = Date.now();
  await assert.rejects(
    retryOnBusy(
      db,
      () => {
        attempts++;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      },
      { budgetMs: 80, pauseMs: 5 },
    ),
    /database is locked/,
  );
  assert.ok(attempts >= 2, `expected retries, got ${attempts}`);
  assert.ok(Date.now() - start >= 70, "the budget must actually elapse");

});

test("retryOnBusy yields to the event loop between attempts", async () => {
  let ticks = 0;
  const loop = setImmediate(() => ticks++);
  try {
    const db = { transaction: null } as never;
    let attempts = 0;
    await assert.rejects(
      retryOnBusy(
        db,
        () => {
          attempts++;
          if (attempts < 3) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        },
        { budgetMs: 60, pauseMs: 5 },
      ),
      /locked/,
    );
    assert.ok(attempts >= 3);
    assert.ok(ticks >= 1, "the event loop must run between attempts");
  } finally {
    clearImmediate(loop);
  }
});

test("retryOnBusy propagates non-lock errors immediately", async () => {
  const db = { transaction: null } as never;
  let attempts = 0;
  await assert.rejects(
    retryOnBusy(
      db,
      () => {
        attempts++;
        throw new Error("syntax error");
      },
      { budgetMs: 500, pauseMs: 5 },
    ),
    /syntax error/,
  );
  assert.equal(attempts, 1, "a non-lock error must not be retried");
});

test("a lock error mid-closure rolls the whole transaction back and retries it whole", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "busy-retry-"));
  const db = openDb({ dataDir, dbPath: join(dataDir, "data.db"), scope: "global" });
  try {
    db.prepare(
      `INSERT INTO sessions (id, name, status, created_at, last_heartbeat_at)
       VALUES ('s1', 'one', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();

    let attempts = 0;
    const result = await retryOnBusy(
      db,
      () =>
        db.transaction(() => {
          attempts++;
          // First write of the closure.
          db.prepare(
            `INSERT INTO sessions (id, name, status, created_at, last_heartbeat_at)
             VALUES ('s2', 'two', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          ).run();
          // Second write fails with a lock error on the first attempt only:
          // the whole transaction (including the first write) must roll
          // back, and the retry must re-run BOTH writes.
          if (attempts === 1)
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
          return "done";
        }).immediate(),
      { budgetMs: 500, pauseMs: 5 },
    );
    assert.equal(result, "done");
    assert.equal(attempts, 2);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id IN ('s1','s2')`)
      .get() as { n: number };
    assert.equal(count.n, 2, "the retried closure applies each write exactly once");
  } finally {
    stopWalCheckpoint(db);
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the shared budget equals the production busy timeout", () => {
  assert.equal(BUSY_TIMEOUT_MS, 10_000);
});
