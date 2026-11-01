const assert = require("node:assert/strict");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { readSoakConfig, seriesSummary, runSoak } = require("./soak.cjs");

test("soak configuration validates durations, sampling and write-rate bounds", () => {
  const defaults = readSoakConfig({});
  assert.ok(defaults.fixedMs > 0 && defaults.writeMs > 0);
  assert.ok(defaults.sampleMs >= 250);
  assert.ok(defaults.writeIntervalMs >= 50);
  for (const env of [
    { PERF_SOAK_FIXED_MS: "-1" },
    { PERF_SOAK_WRITE_MS: "0" },
    { PERF_SOAK_SAMPLE_MS: "100" },
    { PERF_SOAK_SAMPLE_MS: "x" },
    { PERF_SOAK_WRITE_INTERVAL_MS: "10" },
    { PERF_SOAK_SIZE: "1" },
    { PERF_SOAK_FIXED_MS: "999999999999" },
  ])
    assert.throws(() => readSoakConfig(env), undefined, JSON.stringify(env));
});

test("series summary reports endpoints without asserting leak verdicts", () => {
  const summary = seriesSummary([5, 3, 9, 3], "rss");
  assert.deepEqual(summary, {
    first: 5,
    last: 3,
    min: 3,
    max: 9,
    deltaBytes: -2,
    slopeBytesPerSample: -2 / 3,
  });
  assert.throws(() => seriesSummary([], "rss"));
  assert.throws(() => seriesSummary([1, NaN], "rss"));
});

test(
  "short soak run records time series, reconciles writes and cleans up",
  { timeout: 120000 },
  async () => {
    const report = await runSoak({
      config: readSoakConfig({
        PERF_SOAK_FIXED_MS: "3000",
        PERF_SOAK_WRITE_MS: "4000",
        PERF_SOAK_SAMPLE_MS: "500",
        PERF_SOAK_WRITE_INTERVAL_MS: "200",
        PERF_SOAK_SIZE: "25",
      }),
    });
    assert.equal(report.error, undefined, `soak run failed: ${report.error}`);
    assert.equal(report.status, "passed");
    assert.equal(report.phases.fixed.configuredMs, 3000);
    assert.equal(report.phases.write.configuredMs, 4000);
    assert.equal(report.phases.fixed.reads.unexpected, 0);
    assert.equal(report.phases.write.reads.unexpected, 0);
    assert.equal(report.phases.write.writes.unexpected, 0);
    assert.ok(report.phases.write.writes.succeeded >= 1, "write phase must record real writes; pace stays an observation");
    assert.ok(report.timeSeries.length >= 11, "sampling must cover both phases");
    for (const sample of report.timeSeries) {
      assert.ok(sample.worker.rss > 0);
      assert.ok(sample.storage.databaseBytes > 0);
      assert.equal(typeof sample.storage.walBytes, "number");
      assert.equal(typeof sample.counts.contexts, "number");
    }
    assert.equal(report.integrity.passed, true);
    assert.equal(report.integrity.contextsAfter - report.integrity.contextsBefore, report.integrity.writesAcknowledged);
    assert.equal(report.integrity.uniqueIds, report.integrity.writesAcknowledged);
    assert.equal(report.analysis.leakVerdict, "not-assessed");
    assert.ok(report.analysis.workerRss.max >= report.analysis.workerRss.min);
  },
);

test(
  "write phase cannot pass without actual writes",
  { timeout: 120000 },
  async () => {
    const report = await runSoak({
      config: readSoakConfig({
        PERF_SOAK_FIXED_MS: "250",
        PERF_SOAK_WRITE_MS: "1000",
        PERF_SOAK_SAMPLE_MS: "250",
        PERF_SOAK_WRITE_INTERVAL_MS: "50",
        PERF_SOAK_SIZE: "8",
      }),
      simulateWriteFailure: true,
    });
    assert.equal(report.status, "failed");
    assert.equal(report.integrity.passed, false);
    assert.equal(report.integrity.writesAcknowledged, 0);
    assert.match(report.error, /integrity/);
    assert.match(report.error, /"writesAcknowledged":0/);
  },
);

test(
  "slow sampling must not starve the paced write load",
  { timeout: 120000 },
  async () => {
    const report = await runSoak({
      config: readSoakConfig({
        PERF_SOAK_FIXED_MS: "250",
        PERF_SOAK_WRITE_MS: "2000",
        PERF_SOAK_SAMPLE_MS: "250",
        PERF_SOAK_WRITE_INTERVAL_MS: "50",
        PERF_SOAK_SIZE: "8",
      }),
      sampleDelayMs: 400,
    });
    assert.equal(report.error, undefined, `soak run failed: ${report.error}`);
    assert.equal(report.status, "passed");
    // Scheduler-behavior bound, not a pace threshold: if writes were
    // serialized behind every 400 ms sample they could not exceed
    // writeMs/sampleDelayMs; the independent pacer must beat that ceiling
    // by 2x. Machine slowness delays both sides — the ratio is the property.
    const serializedCeiling = Math.ceil(2000 / 400);
    assert.ok(
      report.phases.write.writes.succeeded >= 2 * serializedCeiling,
      `writes starved behind slow samples: ${report.phases.write.writes.succeeded}`,
    );
    assert.ok(report.timeSeries.length >= 2, "sampling stopped entirely under slow samples");
  },
);

test(
  "fixed phase sleeps between samples instead of busy-waiting",
  { timeout: 120000 },
  async () => {
    const report = await runSoak({
      config: readSoakConfig({
        PERF_SOAK_FIXED_MS: "2000",
        PERF_SOAK_WRITE_MS: "1000",
        PERF_SOAK_SAMPLE_MS: "250",
        PERF_SOAK_WRITE_INTERVAL_MS: "50",
        PERF_SOAK_SIZE: "8",
      }),
    });
    assert.equal(report.status, "passed");
    // Scheduler-behavior bound: with sleep-until-due the sampler only
    // wakes when a tick is due, so idle wakes stay near zero regardless
    // of machine speed — polling the clock would produce thousands.
    assert.ok(
      report.phases.fixed.idleWakeups <= 100,
      `sampler woke ${report.phases.fixed.idleWakeups} times with nothing due — it must sleep until the next tick, not poll`,
    );
  },
);

test(
  "soak coordinator termination cleans up and writes failure",
  { timeout: 60000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "conflux-soak-signal-test-"));
    const temp = join(directory, "tmp");
    mkdirSync(temp);
    const output = join(directory, "report.json");
    const child = spawn(process.execPath, [join(__dirname, "soak.cjs")], {
      env: {
        ...process.env,
        TEMP: temp,
        TMP: temp,
        TMPDIR: temp,
        PERF_SOAK_OUTPUT: output,
        PERF_SOAK_FIXED_MS: "20000",
        PERF_SOAK_WRITE_MS: "20000",
        PERF_SOAK_SAMPLE_MS: "500",
        PERF_SOAK_SIZE: "8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    try {
      await new Promise((resolve, reject) => {
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes("soak phase fixed started")) resolve();
        });
        child.once("exit", () => reject(Error("coordinator exited before the fixed phase")));
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      if (process.platform === "win32") assert.equal(signal, "SIGTERM");
      else {
        assert.equal(code, 1);
        const report = JSON.parse(readFileSync(output, "utf8"));
        assert.equal(report.status, "failed");
        assert.deepEqual(readdirSync(temp), []);
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
