import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

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
// Health coverage is two distinct claims, tested separately:
// 1. While only the lock is held (no contended request in flight),
//    /healthz answers fast — asserted directly below.
// 2. While the server is synchronously waiting on a contended write,
//    /healthz is BLOCKED — better-sqlite3 waits synchronously, so the
//    single-threaded event loop cannot serve anything until the wait ends.
//    An independent client process (health-probe-child.cjs) polls across
//    the blocked window and records the real in-flight latency; this is a
//    documented limitation, not a claim of concurrent availability.
//    Making health answer during a lock wait needs database work off the
//    event loop — tracked as a separate follow-up.
const BUSY_TIMEOUT_MS = 10000;

interface ProbeLine {
  sentAt: number;
  receivedAt: number;
  status: number | null;
  err?: string;
}

test("lock held: health answers with no write in flight; blocked during the wait; write 503s after one timeout, then recovers", { timeout: 90000 }, async (t) => {
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

  // Claim 2: an independent client observes /healthz across the blocked
  // window. The probe runs as its own process because an in-process client
  // shares the frozen event loop and could never observe the freeze.
  const port = (app.server.address() as { port: number }).port;
  const probe = spawn(
    process.execPath,
    [fileURLToPath(new URL("./health-probe-child.cjs", import.meta.url)), `http://127.0.0.1:${port}`, "400"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const probeExited = once(probe, "exit");
  const probeLines: ProbeLine[] = [];
  let stdout = "";
  probe.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    let index: number;
    while ((index = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (line.length > 0) probeLines.push(JSON.parse(line) as ProbeLine);
    }
  });
  const baselineDeadline = Date.now() + 15000;
  while (!(probeLines.length >= 2 && probeLines.every((l) => l.status === 200))) {
    assert.ok(
      Date.now() < baselineDeadline,
      `probe never produced fast baseline responses; lines: ${JSON.stringify(probeLines)}; port: ${port}`,
    );
    await sleep(100);
  }
  for (const line of probeLines) {
    assert.equal(line.status, 200);
    assert.ok(
      line.receivedAt - line.sentAt < 2000,
      `baseline health probe took ${line.receivedAt - line.sentAt} ms before the blocked write`,
    );
  }

  const auditBefore = locker.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };
  const linesBeforeWrite = probeLines.length;

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

  // Let the probe record post-release recovery, then collect the timeline.
  await sleep(1500);
  probe.kill();
  await Promise.race([probeExited, sleep(5000)]);
  if (probe.exitCode === null && probe.signalCode === null) probe.kill();

  const duringAndAfter = probeLines.slice(linesBeforeWrite);
  const blockedProbes = duringAndAfter.filter((l) => l.receivedAt - l.sentAt >= 5000);
  const latencies = duringAndAfter.map((l) => l.receivedAt - l.sentAt);
  assert.ok(
    blockedProbes.length >= 1,
    `expected the in-flight health probe to be blocked by the synchronous wait; latencies: ${JSON.stringify(latencies)}`,
  );
  const maxBlockedMs = Math.max(...blockedProbes.map((l) => l.receivedAt - l.sentAt));
  assert.ok(
    maxBlockedMs >= 5000,
    `the blocked health probe only waited ${maxBlockedMs} ms — expected it to span most of the lock wait`,
  );
  const tail = duringAndAfter.slice(-2);
  assert.ok(
    tail.length === 2 && tail.every((l) => l.status === 200 && l.receivedAt - l.sentAt < 3000),
    `health must recover immediately after the wait ends; tail: ${JSON.stringify(tail)}`,
  );
  t.diagnostic(
    `independent /healthz probe across the lock wait: ${duringAndAfter.length} probes, ` +
      `blocked in-flight max ${maxBlockedMs} ms (write wait ${writeElapsed.toFixed(0)} ms), recovered tail fast`,
  );

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
