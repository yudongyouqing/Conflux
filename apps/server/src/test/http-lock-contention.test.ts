import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Another process holding the SQLite write lock must degrade the HTTP API
// gracefully: the write fails once (503 DATA_LOCKED after one busy
// timeout), health stays answerable, and everything recovers after the
// release. The error-audit write must not wait on the same lock a second
// time — that used to double the user-visible stall.
//
// The audit-skip is asserted through the server log, not wall time: CI
// runners oversleep sqlite's incremental busy callback (one observed macOS
// run took 18.6 s for a single 10 s timeout), so elapsed time is only a
// loose guard while the log line proves which code path ran.
//
// Coverage boundary: the health probes here run while only the lock is
// held, i.e. with no contended request in flight. They do NOT prove that
// /healthz answers during the ~10 s synchronous busy-wait of a blocked
// write: better-sqlite3 waits synchronously, so the single-threaded event
// loop cannot serve anything until the wait ends. Concurrent
// responsiveness under an active lock wait would require moving database
// work off the event loop and is tracked as a separate follow-up.
const BUSY_TIMEOUT_MS = 10000;

test("lock held: health answers with no write in flight; write 503s after one timeout, then recovers", { timeout: 60000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "muiltchat-http-lock-"));
  const dbPath = join(dataDir, "data.db");
  const logFile = join(dataDir, "server.log");
  // Must be set before the first server module import so the shared pino
  // destination points at the readable file.
  process.env.CONFLUX_LOG_FILE = logFile;
  const { openDb, stopWalCheckpoint } = await import("../core/db.js");
  const { registerSession } = await import("../core/sessions.js");
  const { startHttpServer } = await import("../http/server.js");

  const seedDb = openDb({ dataDir, dbPath, scope: "global" });
  registerSession(seedDb, { id: "s1", name: "one" });
  registerSession(seedDb, { id: "web-console", name: "Web 控制台" });

  // node:test runs t.after hooks in registration order and a throwing hook
  // skips the rest — close connections before deleting the directory
  // (Windows EBUSY on an open data.db).
  t.after(() => seedDb.close());

  const app = await startHttpServer({ port: 0, overrideDataDir: dataDir });
  t.after(() => app.close());
  t.after(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // disposable temp dir — leave it behind rather than fail the test
    }
  });

  // A second connection in the role of an external CLI/MCP process.
  const locker = openDb({ dataDir, dbPath, scope: "global" });
  t.after(() => {
    stopWalCheckpoint(locker);
    locker.close();
  });

  const headers = { "X-Session-Id": "s1" };
  const healthStart = performance.now();
  await locker.exec("BEGIN IMMEDIATE");
  locker
    .prepare(
      `INSERT INTO context_entries (session_id, title, content, created_at, updated_at)
       VALUES ('s1', 'held', 'held row', datetime('now'), datetime('now'))`,
    )
    .run();

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.ok(performance.now() - healthStart < 2000, "health must answer while only the lock is held");

  const auditBefore = locker.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };

  const writeStart = performance.now();
  const blocked = await app.inject({
    method: "POST",
    url: "/context",
    headers,
    payload: { title: "contended", content: "contended write" },
  });
  const writeElapsed = performance.now() - writeStart;
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().code, "DATA_LOCKED");
  // Loose guards only: the real busy timeout must elapse, and a pathological
  // third wait would exceed this. The path discrimination lives in the log.
  assert.ok(
    writeElapsed >= BUSY_TIMEOUT_MS - 1000,
    `reply arrived after ${writeElapsed.toFixed(0)} ms — the real busy timeout must elapse`,
  );
  assert.ok(
    writeElapsed < 3 * BUSY_TIMEOUT_MS,
    `reply took ${writeElapsed.toFixed(0)} ms — far beyond even an overslept single timeout`,
  );

  // The decisive assertion: the lock-error reply skipped its audit write
  // instead of queueing behind the same lock for another timeout.
  await sleep(300);
  const logText = readFileSync(logFile, "utf8");
  assert.match(
    logText,
    /skipping error audit while the database is locked/,
    "lock-error replies must skip the synchronous audit write",
  );
  assert.doesNotMatch(logText, /failed to audit HTTP error/);

  // The failed contended write leaves no row; recovery works after release.
  locker.exec("ROLLBACK");
  const heldRows = locker
    .prepare(`SELECT COUNT(*) AS n FROM context_entries WHERE title = 'held'`)
    .get() as { n: number };
  assert.equal(heldRows.n, 0, "rolled-back holder transaction left rows");

  const recovered = await app.inject({
    method: "POST",
    url: "/context",
    headers,
    payload: { title: "recovered", content: "recovered write" },
  });
  assert.equal(recovered.statusCode, 200);
  assert.ok(recovered.json().entry.id > 0);

  const healthAfter = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(healthAfter.statusCode, 200);

  // Non-lock errors keep their audit row; the lock error intentionally
  // does not get one (its record is the structured error log).
  const notFound = await app.inject({ method: "DELETE", url: "/context/999999", headers });
  assert.equal(notFound.statusCode, 404);
  const auditAfter = locker.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };
  assert.equal(
    auditAfter.n - auditBefore.n,
    2,
    "expected exactly the recovered write and the 404 to be audited",
  );
});
