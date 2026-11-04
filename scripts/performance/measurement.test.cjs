const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readConfig, summarize, measureSync, runConcurrent } = require("./measurement.cjs");

test("summary uses nearest-rank percentiles and preserves raw input order", () => {
  const values = [4, 1, 3, 2];
  assert.deepEqual(summarize(values), { count: 4, p50Ms: 2, p95Ms: 4, minMs: 1, maxMs: 4 });
  assert.deepEqual(values, [4, 1, 3, 2]);
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([NaN]));
});

test("benchmark configuration rejects unsafe or misleading sample settings", () => {
  assert.deepEqual(readConfig({}), {
    sizes: [25, 100, 300],
    samples: 100,
    warmup: 10,
    concurrency: [1, 8],
  });
  for (const env of [
    { PERF_SERVER_SAMPLES: "0" },
    { PERF_SERVER_SAMPLES: "19" },
    { PERF_SERVER_SIZES: "1,100" },
    { PERF_SERVER_SIZES: "25,,300" },
    { PERF_SERVER_CONCURRENCY: "0" },
    { PERF_SERVER_CONCURRENCY: "1,1" },
    { PERF_SERVER_WARMUP: "NaN" },
    { PERF_SERVER_SAMPLES: "1e9" },
  ])
    assert.throws(() => readConfig(env));
});

test("sync measurement validates warm-ups but excludes them from observations", () => {
  let calls = 0;
  const seen = [];
  const result = measureSync(
    () => ++calls,
    (value) => seen.push(value),
    4,
    2,
  );
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.equal(result.latenciesMs.length, 4);
  assert.equal(result.summary.count, 4);
  assert.ok(result.successfulOpsPerSec > 0);
  assert.throws(
    () =>
      measureSync(
        () => null,
        () => {
          throw Error("invalid result");
        },
        4,
        1,
      ),
    /invalid result/,
  );
});

test("closed-loop runner bounds in-flight work and accounts for every failure", async () => {
  let active = 0;
  let peak = 0;
  const visited = [];
  const result = await runConcurrent(12, 3, async (index) => {
    active++;
    peak = Math.max(active, peak);
    visited.push(index);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (index === 4) throw Error("synthetic failure");
  });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(
    visited.sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, i) => i),
  );
  assert.equal(result.latenciesMs.length, 12);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 4);
  assert.match(result.failures[0].message, /synthetic failure/);
  assert.ok(result.successfulOpsPerSec > 0);
  await assert.rejects(runConcurrent(0, 1, async () => {}));
  await assert.rejects(runConcurrent(10, 0, async () => {}));
  const invalid = await runConcurrent(
    3,
    2,
    async () => ({ ok: false }),
    (v) => assert.equal(v.ok, true),
  );
  assert.equal(invalid.failures.length, 3);
  assert.equal(invalid.successfulOpsPerSec, 0);
});
