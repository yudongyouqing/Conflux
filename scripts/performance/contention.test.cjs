const assert = require("node:assert/strict");
const { once } = require("node:events");
const { fork, spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { readContentionConfig, classifyContentionError, runContention } = require("./contention.cjs");

test("contention configuration validates bounds and cross-field rules", () => {
  const defaults = readContentionConfig({});
  assert.equal(defaults.longHoldMs > 10000, true, "long hold must exceed the production busy timeout");
  assert.deepEqual(
    {
      holdMs: defaults.holdMs,
      shortBusyTimeoutMs: defaults.shortBusyTimeoutMs,
      writesPerSide: defaults.writesPerSide,
      size: defaults.size,
    },
    { holdMs: 1500, shortBusyTimeoutMs: 50, writesPerSide: 120, size: 25 },
  );
  for (const env of [
    { PERF_CONTENTION_LONG_HOLD_MS: "10000" },
    { PERF_CONTENTION_LONG_HOLD_MS: "abc" },
    { PERF_CONTENTION_HOLD_MS: "100" },
    { PERF_CONTENTION_HOLD_MS: "100000" },
    { PERF_CONTENTION_SHORT_BUSY_MS: "2000" },
    { PERF_CONTENTION_WRITES: "5" },
    { PERF_CONTENTION_SIZE: "1" },
  ])
    assert.throws(() => readContentionConfig(env), undefined, JSON.stringify(env));
});

test("error classification separates expected lock contention from unexpected failures", () => {
  assert.equal(classifyContentionError({ code: "SQLITE_BUSY", message: "database is locked" }), "expected-lock");
  assert.equal(classifyContentionError({ code: "SQLITE_BUSY_SNAPSHOT" }), "expected-lock");
  assert.equal(classifyContentionError({ code: "SQLITE_LOCKED", message: "database table is locked" }), "expected-lock");
  assert.equal(classifyContentionError({ message: "database is locked" }), "expected-lock");
  assert.equal(
    classifyContentionError({ statusCode: 503, body: { code: "DATA_LOCKED", message: "busy" } }),
    "expected-lock",
  );
  assert.equal(classifyContentionError({ code: "SQLITE_CORRUPT" }), "unexpected");
  assert.equal(classifyContentionError(new Error("socket hang up")), "unexpected");
  assert.equal(classifyContentionError({ statusCode: 500, body: { code: "INTERNAL_ERROR" } }), "unexpected");
});

test(
  "multi-process contention preserves integrity across all scenarios",
  { timeout: 240000 },
  async () => {
    const report = await runContention({
      config: readContentionConfig({
        PERF_CONTENTION_HOLD_MS: "800",
        PERF_CONTENTION_LONG_HOLD_MS: "10500",
        PERF_CONTENTION_WRITES: "24",
        PERF_CONTENTION_SIZE: "8",
      }),
    });
    assert.equal(report.error, undefined, `contention run failed: ${report.error}`);
    assert.equal(report.status, "passed");
    const byName = Object.fromEntries(report.scenarios.map((s) => [s.name, s]));
    const read = byName["read-during-uncommitted-write"];
    assert.equal(read.isolationConfirmed, true, "WAL readers must not see the uncommitted marker");
    assert.equal(read.visibleAfterCommit, true);
    assert.ok(read.reads.succeeded > 0);
    assert.equal(byName["release-recovery"].outcome, "succeeded");
    const victim = byName["short-timeout-victim"];
    assert.equal(victim.outcome, "expected-lock");
    assert.match(victim.errorCode, /^SQLITE_BUSY/);
    assert.equal(victim.retry.outcome, "succeeded");
    const timeout = byName["production-timeout"];
    assert.equal(timeout.httpStatus, 503);
    assert.equal(timeout.bodyCode, "DATA_LOCKED");
    assert.ok(timeout.waitedMs >= 9000, "production busy timeout should be observed, not skipped");
    assert.equal(timeout.followUp.outcome, "succeeded");
    const burst = byName["two-writer-burst"];
    assert.equal(burst.http.unexpected, 0);
    assert.equal(burst.writer.unexpected, 0);
    assert.equal(burst.http.succeeded, 24);
    assert.equal(burst.writer.succeeded, 24);
    const death = byName["writer-death-recovery"];
    assert.equal(death.markerRolledBack, true, "killed writer transaction must disappear entirely");
    assert.equal(death.followUp.outcome, "succeeded");
    assert.equal(report.integrity.passed, true);
    assert.equal(report.integrity.duplicateMarkers, false);
    assert.equal(report.integrity.lostMarkers, false);
    assert.equal(report.aggregates.httpWrites.unexpected, 0);
    assert.equal(report.aggregates.writerWrites.unexpected, 0);
    assert.ok(report.latencies.httpWriteMs.length >= 24);
    assert.ok(report.storage.walBytes !== undefined);
  },
);

test(
  "contention coordinator termination cleans up children and writes failure",
  { timeout: 60000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "conflux-contention-signal-test-"));
    const temp = join(directory, "tmp");
    mkdirSync(temp);
    const output = join(directory, "report.json");
    const child = spawn(process.execPath, [join(__dirname, "contention.cjs")], {
      env: {
        ...process.env,
        TEMP: temp,
        TMP: temp,
        TMPDIR: temp,
        PERF_CONTENTION_OUTPUT: output,
        PERF_CONTENTION_HOLD_MS: "800",
        PERF_CONTENTION_LONG_HOLD_MS: "10500",
        PERF_CONTENTION_WRITES: "12",
        PERF_CONTENTION_SIZE: "8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let writerPid = null;
    try {
      await new Promise((resolve, reject) => {
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const match = stdout.match(/contention writer pid (\d+)/);
          if (match) writerPid = Number(match[1]);
          if (stdout.includes("contention scenario read-during-uncommitted-write")) resolve();
        });
        child.once("exit", () => reject(Error("coordinator exited before first scenario")));
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      if (process.platform === "win32") {
        assert.equal(signal, "SIGTERM");
      } else {
        assert.equal(code, 1);
        assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "failed");
        assert.deepEqual(readdirSync(temp), []);
      }
      if (writerPid !== null) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try {
            process.kill(writerPid, 0);
          } catch {
            break; // worker observed the disconnect and exited
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.throws(() => process.kill(writerPid, 0), undefined, "writer must not outlive its coordinator");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
