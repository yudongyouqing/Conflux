const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

function integer(value, name, min, max) {
  assert.match(String(value), /^\d+$/, `${name} must be an integer`);
  const number = Number(value);
  assert.ok(
    Number.isSafeInteger(number) && number >= min && number <= max,
    `${name} must be ${min}..${max}`,
  );
  return number;
}

function readConfig(env = process.env) {
  const list = (value, name, min, max) => {
    const items = value.split(",").map((v) => integer(v.trim(), name, min, max));
    assert.equal(new Set(items).size, items.length, `${name} contains duplicates`);
    return items;
  };
  return {
    sizes: list(env.PERF_SERVER_SIZES ?? "25,100,300", "PERF_SERVER_SIZES", 2, 3000),
    samples: integer(env.PERF_SERVER_SAMPLES ?? 100, "PERF_SERVER_SAMPLES", 20, 10000),
    warmup: integer(env.PERF_SERVER_WARMUP ?? 10, "PERF_SERVER_WARMUP", 1, 1000),
    concurrency: list(env.PERF_SERVER_CONCURRENCY ?? "1,8", "PERF_SERVER_CONCURRENCY", 1, 64),
  };
}

function summarize(values) {
  assert.ok(
    values.length > 0 && values.every((v) => Number.isFinite(v) && v >= 0),
    "Invalid observations",
  );
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

function snapshot() {
  return {
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
    lifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

function resourceDelta(before, after) {
  return {
    cpuUserMs: (after.cpu.user - before.cpu.user) / 1000,
    cpuSystemMs: (after.cpu.system - before.cpu.system) / 1000,
    memoryBefore: before.memory,
    memoryAfter: after.memory,
    lifetimeMaxRssBytes: after.lifetimeMaxRssBytes,
  };
}

function measureSync(operation, validate, samples, warmup) {
  for (let i = 0; i < warmup; i++) validate(operation());
  const before = snapshot();
  const start = performance.now();
  const latenciesMs = [];
  for (let i = 0; i < samples; i++) {
    const at = performance.now();
    const result = operation();
    latenciesMs.push(performance.now() - at);
    validate(result);
  }
  const elapsedMs = performance.now() - start;
  return {
    latenciesMs,
    summary: summarize(latenciesMs),
    elapsedMs,
    successfulOpsPerSec: (samples * 1000) / elapsedMs,
    failures: [],
    resources: resourceDelta(before, snapshot()),
  };
}

async function runConcurrent(samples, concurrency, operation, validate = () => {}) {
  integer(samples, "samples", 1, 10000);
  integer(concurrency, "concurrency", 1, 64);
  const latenciesMs = new Array(samples);
  const failures = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(samples, concurrency) }, async () => {
      while (next < samples) {
        const index = next++;
        const at = performance.now();
        try {
          const result = await operation(index);
          latenciesMs[index] = performance.now() - at;
          validate(result);
        } catch (error) {
          failures.push({ index, message: error.message });
        } finally {
          latenciesMs[index] ??= performance.now() - at;
        }
      }
    }),
  );
  const elapsedMs = performance.now() - start;
  return {
    latenciesMs,
    summary: summarize(latenciesMs),
    failures,
    elapsedMs,
    successfulOpsPerSec: ((samples - failures.length) * 1000) / elapsedMs,
  };
}

module.exports = { readConfig, summarize, measureSync, runConcurrent, snapshot, resourceDelta };
