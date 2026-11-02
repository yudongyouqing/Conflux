// Cross-process SQLite contention benchmark. An HTTP server process and an
// independent CLI/MCP-style writer process share one temporary database
// file. Lock state is coordinated by IPC acknowledgements, never inferred
// from sleeps, so every busy/timeout observation is deterministic.
const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir, cpus, totalmem, platform, release, arch } = require("node:os");
const { join, resolve, dirname } = require("node:path");
const { Agent } = require("node:http");
const { performance } = require("node:perf_hooks");
const { summarize, snapshot, resourceDelta } = require("./measurement.cjs");
const { requestJson } = require("./http-client.cjs");
const { waitMessage, isolatedEnvironment } = require("./server-database.cjs");
const root = resolve(__dirname, "../..");

// The production busy timeout from core/db.ts; the long hold must exceed it
// for the timeout path to be observable through the real HTTP server.
const PRODUCTION_BUSY_TIMEOUT_MS = 10000;

function option(env, name, fallback, min, max) {
  const raw = env[name] ?? fallback;
  assert.match(String(raw), /^\d+$/, `${name} must be an integer`);
  const number = Number(raw);
  assert.ok(number >= min && number <= max, `${name} must be ${min}..${max}`);
  return number;
}

function readContentionConfig(env = process.env) {
  const config = {
    holdMs: option(env, "PERF_CONTENTION_HOLD_MS", 1500, 200, 60000),
    longHoldMs: option(env, "PERF_CONTENTION_LONG_HOLD_MS", 12000, PRODUCTION_BUSY_TIMEOUT_MS + 1, 300000),
    shortBusyTimeoutMs: option(env, "PERF_CONTENTION_SHORT_BUSY_MS", 50, 5, 1000),
    writesPerSide: option(env, "PERF_CONTENTION_WRITES", 120, 10, 5000),
    size: option(env, "PERF_CONTENTION_SIZE", 25, 2, 3000),
  };
  assert.ok(
    config.shortBusyTimeoutMs < config.holdMs,
    "PERF_CONTENTION_SHORT_BUSY_MS must stay below the hold window",
  );
  return config;
}

/** Classify a failure as expected lock contention or an unexpected error. */
function classifyContentionError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  if (/^SQLITE_(BUSY|LOCKED)/.test(code)) return "expected-lock";
  if (/\bdatabase is locked\b/i.test(message)) return "expected-lock";
  if (error?.body?.code === "DATA_LOCKED") return "expected-lock";
  return "unexpected";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeToken(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1679616).toString(36)}`;
}

async function runContention({ config, directory, output } = {}) {
  const report = {
    schemaVersion: 1,
    kind: "contention",
    status: "running",
    startedAt: new Date().toISOString(),
    source: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty:
        execFileSync(
          "git",
          ["status", "--porcelain", "--", "scripts/performance", "apps/server", "packages/shared"],
          { cwd: root, encoding: "utf8" },
        ).trim().length > 0,
    },
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    config,
    methodology: {
      topology: "HTTP server process and one external writer process share one SQLite file (WAL)",
      lockState:
        "BEGIN IMMEDIATE and its release are acknowledged over IPC before any victim runs; no sleep-based guessing",
      auditedReads:
        "HTTP data reads write audit/heartbeat rows and therefore join write contention; /healthz is the write-free path, and the writer's second connection provides un-audited cross-process reads",
      shortTimeout:
        `the victim uses a test-only second connection with busy_timeout=${config.shortBusyTimeoutMs}ms to observe timeout classification quickly; production connections keep busy_timeout=${PRODUCTION_BUSY_TIMEOUT_MS}ms`,
      productionTimeout:
        "one write per run goes through the real HTTP server against a hold longer than the production busy timeout",
      recovery: "release-to-response, after-timeout and after-writer-death latencies are wall-clock observations",
      latencies: "httpWriteMs are full round trips; writerWriteMs are in-process database operations",
      scope: "single-machine observation on one temporary database; no thresholds are asserted",
    },
    scenarios: [],
    integrity: null,
    aggregates: null,
    latencies: null,
    recovery: null,
    resources: null,
    storage: null,
  };
  const ownDirectory = !directory;
  const dir = directory ?? mkdtempSync(join(tmpdir(), "conflux-contention-"));
  const env = isolatedEnvironment(dir);
  const aggregates = {
    httpWrites: { succeeded: 0, expectedLock: 0, unexpected: 0 },
    writerWrites: { succeeded: 0, expectedLock: 0, unexpected: 0 },
    reads: { succeeded: 0, unexpected: 0 },
  };
  const recovery = { releaseMs: [], afterTimeoutMs: null, afterWriterDeathMs: null, shortTimeoutRetryMs: null };
  const httpWriteMs = [];
  let writerWriteMs = [];
  const server = fork(
    join(__dirname, "server-worker.cjs"),
    [JSON.stringify({ directory: dir, size: config.size, samples: 20, warmup: 1 })],
    { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let writer = null;
  let agent = null;
  const serverExited = new Promise((resolve) => server.once("exit", resolve));
  let writerExited = null;
  const deadlineMs = Math.min(600000, 180000 + config.longHoldMs + config.writesPerSide * 100);
  let terminated = false;
  const onTerminate = () => {
    terminated = true;
    server.kill();
    writer?.kill();
  };
  process.once("SIGINT", onTerminate);
  process.once("SIGTERM", onTerminate);
  const deadline = setTimeout(onTerminate, deadlineMs);
  let commandIds = 0;
  const rpc = (child, command, timeoutMs = 60000) => {
    const id = ++commandIds;
    return waitMessage(child, { id, ...command }, (m) => m.id === id, timeoutMs);
  };
  const serverSnapshot = () => rpc(server, { command: "snapshot" });
  let url = null;
  let expectedContextRows = 0;
  let writerResourcesBefore = null;
  let serverResourcesBefore = null;

  async function httpRead(path, check) {
    try {
      const response = await requestJson(url + path, { agent });
      if (check) check(response.json);
      aggregates.reads.succeeded++;
      return response.json;
    } catch (error) {
      aggregates.reads.unexpected++;
      throw error;
    }
  }

  async function httpWrite(content, extra = {}) {
    const at = performance.now();
    try {
      const response = await requestJson(url + "/context", {
        agent,
        body: {
          title: `Contention ${content}`,
          content,
          tags: ["contention"],
        },
        timeoutMs: config.longHoldMs + 20000,
        acceptStatus: [503],
        ...extra,
      });
      httpWriteMs.push(performance.now() - at);
      if (response.statusCode === 200) {
        aggregates.httpWrites.succeeded++;
        return { outcome: "succeeded", statusCode: 200, json: response.json };
      }
      if (response.statusCode === 503 && response.json?.code === "DATA_LOCKED") {
        aggregates.httpWrites.expectedLock++;
        return { outcome: "expected-lock", statusCode: 503, json: response.json };
      }
      aggregates.httpWrites.unexpected++;
      return { outcome: "unexpected", statusCode: response.statusCode, json: response.json };
    } catch (error) {
      httpWriteMs.push(performance.now() - at);
      aggregates.httpWrites.unexpected++;
      return { outcome: "unexpected", statusCode: null, error: error.message };
    }
  }

  async function queryMarker(marker, limit = 500) {
    const json = await httpRead(
      `/context/query?query=${marker}&limit=${limit}`,
      (v) => assert.ok(Array.isArray(v.entries)),
    );
    return json.entries;
  }

  async function stopWorker(child, exited, command = "stop") {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      await rpc(child, { command }, 15000);
      await Promise.race([exited, sleep(5000)]);
    } catch {
      child.kill();
      await Promise.race([exited, sleep(10000)]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }

  try {
    const ready = await waitMessage(server, null, (m) => m.ready, 60000);
    url = ready.url;
    console.log(`HTTP ready on ${url} with ${config.size} synthetic sessions`);
    agent = new Agent({ keepAlive: true, maxSockets: 4 });
    expectedContextRows = ready.before.counts.contexts;
    serverResourcesBefore = (await serverSnapshot()).resources;

    writer = fork(
      join(__dirname, "contention-writer.cjs"),
      [JSON.stringify({ dataDir: join(dir, "http"), dbPath: join(dir, "http", "data.db") })],
      { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    writerExited = new Promise((resolve) => writer.once("exit", (code, signal) => resolve([code, signal])));
    const writerReady = await waitMessage(writer, null, (m) => m.ready, 30000);
    console.log(`contention writer pid ${writer.pid} opened the shared database`);
    report.writerPragmas = writerReady.pragmas;
    writerResourcesBefore = (await rpc(writer, { command: "counts-storage" })).resources;

    // 1. WAL readers proceed while a write transaction is uncommitted.
    console.log("contention scenario read-during-uncommitted-write");
    {
      const marker = makeToken("cthiso");
      // Audited data reads participate in write contention through their
      // audit rows, so response-shape checks run before any lock is held.
      await httpRead("/graph?status=all", (v) => {
        assert.equal(v.nodes.length, config.size + 1);
        assert.equal(v.edges.length, config.size);
      });
      await rpc(writer, { command: "hold", marker });
      // The write-free health path must stay available during the hold.
      await httpRead("/healthz", (v) => assert.equal(v.ok, true));
      await httpRead("/healthz", (v) => assert.equal(v.ok, true));
      // Cross-process WAL reader: sees the pre-transaction snapshot.
      const during = await rpc(writer, { command: "victim-read", marker });
      const isolationConfirmed = during.rows === 0;
      // An audited data read fired during the hold completes only after the
      // release because its audit write waits for the lock — observed as a
      // behavior, not judged here.
      const auditedReadStartedAt = performance.now();
      const auditedRead = queryMarker(marker);
      await rpc(writer, { command: "release", mode: "commit" });
      const entries = await auditedRead;
      const auditedReadWaitMs = performance.now() - auditedReadStartedAt;
      const victimAfter = await rpc(writer, { command: "victim-read", marker });
      expectedContextRows += 3;
      // The audited read's DATA reflects whichever side of the commit its
      // queryContext snapshot landed on — with fast IPC the commit can beat
      // the read, with fast TCP the read can win; both orders are correct
      // WAL behavior. What the lock gates deterministically is the audit
      // WRITE, so the post-commit visibility is asserted through the
      // second connection read after the release acknowledgement.
      const visibleAfterCommit = victimAfter.rows === 3 && (entries.length === 0 || entries.length === 3);
      report.scenarios.push({
        name: "read-during-uncommitted-write",
        status: isolationConfirmed && visibleAfterCommit ? "passed" : "failed",
        reads: { ...aggregates.reads },
        isolationConfirmed,
        visibleAfterCommit,
        uncommittedVisibleRows: during.rows,
        committedRows: victimAfter.rows,
        auditedReadRows: entries.length,
        auditedReadWaitMs,
      });
      assert.equal(isolationConfirmed, true, "uncommitted rows leaked to WAL readers");
      assert.equal(visibleAfterCommit, true, "committed rows missing after release");
    }

    // 2. A write that starts while the lock is held succeeds once released.
    console.log("contention scenario release-recovery");
    {
      const marker = makeToken("cthrel");
      await rpc(writer, { command: "hold", marker });
      await httpRead("/healthz", (v) => assert.equal(v.ok, true));
      const requestSentAt = performance.now();
      const pending = httpWrite(`${marker} http`);
      // Loopback arrival cushion only — the lock itself is already
      // acknowledged; this bias ensures the request reaches the busy wait.
      await sleep(150);
      const releaseSentAt = performance.now();
      // The held rows are scaffolding for this scenario; rolling them back
      // releases the lock and leaves exactly the recovered victim write.
      await rpc(writer, { command: "release", mode: "rollback" });
      const response = await pending;
      const respondedAt = performance.now();
      const rows = await queryMarker(marker);
      expectedContextRows += 1;
      recovery.releaseMs.push(respondedAt - releaseSentAt);
      report.scenarios.push({
        name: "release-recovery",
        outcome: response.outcome,
        configuredHoldMs: config.holdMs,
        releaseMode: "rollback",
        waitMs: respondedAt - requestSentAt,
        releaseToResponseMs: respondedAt - releaseSentAt,
        rowsVisible: rows.length,
      });
      assert.equal(response.outcome, "succeeded", "write did not recover after lock release");
      assert.equal(rows.length, 1, "released write must appear exactly once");
    }

    // 3. A short test-only busy timeout makes the lock error observable fast.
    console.log("contention scenario short-timeout-victim");
    {
      const holdMarker = makeToken("cthv");
      const victimMarker = makeToken("ctvv");
      await rpc(writer, { command: "hold", marker: holdMarker });
      const attempt = await rpc(writer, {
        command: "victim-write",
        marker: victimMarker,
        busyTimeoutMs: config.shortBusyTimeoutMs,
      });
      assert.equal(attempt.outcome, "expected-lock", `victim outcome: ${attempt.outcome}`);
      assert.match(attempt.errorCode, /^SQLITE_BUSY/);
      const duringFailure = await rpc(writer, { command: "victim-read", marker: victimMarker });
      await rpc(writer, { command: "release", mode: "commit" });
      expectedContextRows += 3;
      const retryStartedAt = performance.now();
      const retry = await rpc(writer, {
        command: "victim-write",
        marker: `${victimMarker}r`,
        busyTimeoutMs: PRODUCTION_BUSY_TIMEOUT_MS,
      });
      recovery.shortTimeoutRetryMs = performance.now() - retryStartedAt;
      const afterRetry = await rpc(writer, { command: "victim-read", marker: victimMarker });
      expectedContextRows += 1;
      report.scenarios.push({
        name: "short-timeout-victim",
        outcome: attempt.outcome,
        errorCode: attempt.errorCode,
        rowsVisibleDuringLock: duringFailure.rows,
        retry: { outcome: retry.outcome, recoveryMs: recovery.shortTimeoutRetryMs },
      });
      assert.equal(duringFailure.rows, 0, "failed victim write must leave no rows");
      assert.equal(retry.outcome, "succeeded", "victim retry did not recover after release");
      assert.equal(afterRetry.rows, 1);
    }

    // 4. The production busy timeout surfaces as HTTP 503 DATA_LOCKED.
    console.log("contention scenario production-timeout");
    {
      const holdMarker = makeToken("cthpto");
      const writeMarker = makeToken("cthptw");
      await rpc(writer, { command: "hold", marker: holdMarker });
      const requestSentAt = performance.now();
      const response = await httpWrite(`${writeMarker} http`);
      const respondedAt = performance.now();
      const waitedMs = respondedAt - requestSentAt;
      await rpc(writer, { command: "release", mode: "rollback" });
      const rolledBack = await queryMarker(holdMarker);
      const followUpStartedAt = performance.now();
      const followUp = await httpWrite(`${writeMarker} follow-up`);
      recovery.afterTimeoutMs = performance.now() - followUpStartedAt;
      const followUpRows = await queryMarker(writeMarker);
      expectedContextRows += 1;
      report.scenarios.push({
        name: "production-timeout",
        httpStatus: response.statusCode,
        bodyCode: response.json?.code ?? null,
        waitedMs,
        busyTimeoutMs: PRODUCTION_BUSY_TIMEOUT_MS,
        heldRowsAfterRollback: rolledBack.length,
        followUp: { outcome: followUp.outcome, recoveryMs: recovery.afterTimeoutMs },
      });
      assert.equal(response.outcome, "expected-lock", "long hold must produce a lock error");
      assert.equal(response.statusCode, 503);
      assert.equal(response.json?.code, "DATA_LOCKED");
      assert.ok(waitedMs >= PRODUCTION_BUSY_TIMEOUT_MS - 1000, "timeout fired too early to be real");
      assert.equal(rolledBack.length, 0, "rolled-back transaction left rows behind");
      assert.equal(followUp.outcome, "succeeded", "server did not recover after the timeout");
      assert.equal(followUpRows.length, 1);
    }

    // 5. Two writers compete for the write lock with continuous interleaving.
    console.log("contention scenario two-writer-burst");
    {
      const token = makeToken("ctb");
      const httpSucceededBefore = aggregates.httpWrites.succeeded;
      const httpExpectedLockBefore = aggregates.httpWrites.expectedLock;
      const httpUnexpectedBefore = aggregates.httpWrites.unexpected;
      const burst = rpc(writer, { command: "write-burst", count: config.writesPerSide, token });
      for (let i = 0; i < config.writesPerSide; i++)
        await httpWrite(`${token} http ${i}`);
      const writerResult = await burst;
      writerWriteMs = writerResult.latenciesMs;
      aggregates.writerWrites.succeeded += writerResult.succeeded;
      aggregates.writerWrites.expectedLock += writerResult.expectedLock;
      aggregates.writerWrites.unexpected += writerResult.unexpected;
      const httpSucceededHere = aggregates.httpWrites.succeeded - httpSucceededBefore;
      expectedContextRows += writerResult.succeeded + httpSucceededHere;
      const matched = await queryMarker(token);
      const contents = matched.map((entry) => entry.content);
      const duplicateMarkers = new Set(contents).size !== contents.length;
      const expectedRows = writerResult.succeeded + httpSucceededHere;
      const lostMarkers = contents.length !== expectedRows;
      const writerCounts = await rpc(writer, { command: "counts-storage" });
      report.scenarios.push({
        name: "two-writer-burst",
        http: {
          succeeded: httpSucceededHere,
          expectedLock: aggregates.httpWrites.expectedLock - httpExpectedLockBefore,
          unexpected: aggregates.httpWrites.unexpected - httpUnexpectedBefore,
        },
        writer: {
          succeeded: writerResult.succeeded,
          expectedLock: writerResult.expectedLock,
          unexpected: writerResult.unexpected,
          unexpectedErrors: writerResult.unexpectedErrors,
        },
        ftsMatched: matched.length,
        expectedRows,
        duplicateMarkers,
        lostMarkers,
        writerObservedRows: writerCounts.counts.contexts,
      });
      assert.equal(writerResult.unexpected, 0, `unexpected writer errors: ${writerResult.unexpectedErrors}`);
      assert.equal(duplicateMarkers, false, "duplicate rows detected after burst");
      assert.equal(lostMarkers, false, "lost rows detected after burst");
      assert.equal(
        writerCounts.counts.contexts,
        expectedContextRows,
        "writer-side row count diverged from expectations",
      );
    }

    // Last observation taken while both processes are still alive; the
    // writer dies in the final scenario on purpose.
    const writerFinal = await rpc(writer, { command: "counts-storage" });

    // 6. A writer dying mid-transaction releases its lock and rolls back.
    console.log("contention scenario writer-death-recovery");
    {
      const holdMarker = makeToken("cthd");
      const writeMarker = makeToken("ctwd");
      await rpc(writer, { command: "hold", marker: holdMarker });
      writer.kill();
      const [exitCode, exitSignal] = await writerExited;
      const followUpStartedAt = performance.now();
      const followUp = await httpWrite(`${writeMarker} http`);
      recovery.afterWriterDeathMs = performance.now() - followUpStartedAt;
      const markerRows = await queryMarker(holdMarker);
      expectedContextRows += 1;
      report.scenarios.push({
        name: "writer-death-recovery",
        exitCode,
        exitSignal,
        markerRolledBack: markerRows.length === 0,
        followUp: { outcome: followUp.outcome, recoveryMs: recovery.afterWriterDeathMs },
      });
      assert.equal(markerRows.length, 0, "abruptly killed transaction was not rolled back");
      assert.equal(followUp.outcome, "succeeded", "lock survived the writer's death");
    }

    const finalSnapshot = await serverSnapshot();
    const actualContextRows = finalSnapshot.counts.contexts;
    const integrity = {
      expectedContextRows,
      actualContextRows,
      writerObservedRowsAfterBurst: writerFinal.counts.contexts,
      duplicateMarkers: false,
      lostMarkers: false,
      passed: actualContextRows === expectedContextRows,
    };
    report.integrity = integrity;
    report.aggregates = aggregates;
    report.latencies = {
      httpWriteMs,
      writerWriteMs,
      summaryHttpWrite: httpWriteMs.length ? summarize(httpWriteMs) : null,
      summaryWriterWrite: writerWriteMs.length ? summarize(writerWriteMs) : null,
    };
    report.recovery = recovery;
    report.resources = {
      httpServer: resourceDelta(serverResourcesBefore, finalSnapshot.resources),
      writer: resourceDelta(writerResourcesBefore, writerFinal.resources),
    };
    report.storage = finalSnapshot.storage;
    assert.deepEqual(
      [integrity.passed, aggregates.httpWrites.unexpected, aggregates.writerWrites.unexpected],
      [true, 0, 0],
      "integrity or unexpected-error checks failed",
    );
    await stopWorker(server, serverExited, "stop");
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = `${error.message}`;
    report.aggregates = aggregates;
    report.recovery = recovery;
    return report;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", onTerminate);
    process.off("SIGTERM", onTerminate);
    agent?.destroy();
    if (!terminated) {
      await stopWorker(writer, writerExited ?? Promise.resolve(0), "close");
      await stopWorker(server, serverExited, "stop");
    } else {
      server.kill();
      writer?.kill();
    }
    if (ownDirectory)
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function main() {
  const config = readContentionConfig();
  const output = resolve(
    process.env.PERF_CONTENTION_OUTPUT ?? join(root, "test-results/performance/contention.json"),
  );
  return runContention({ config, output }).then((report) => {
    report.finishedAt = new Date().toISOString();
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(`Report: ${output} (${report.status})`);
    if (report.status !== "passed") process.exitCode = 1;
  });
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { readContentionConfig, classifyContentionError, runContention };
