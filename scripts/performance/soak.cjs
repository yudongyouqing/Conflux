// Long-running soak benchmark for the HTTP server and its SQLite database.
// A fixed-data phase isolates steady-state read memory from a continuous
// write phase, sampling the server process, the database/WAL files and the
// coordinator over time. Results are observations only — a single run on
// one machine never becomes a threshold or a leak verdict.
const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir, cpus, totalmem, platform, release, arch } = require("node:os");
const { join, resolve, dirname } = require("node:path");
const { Agent } = require("node:http");
const { requestJson } = require("./http-client.cjs");
const { waitMessage, isolatedEnvironment } = require("./server-database.cjs");
const root = resolve(__dirname, "../..");

function option(env, name, fallback, min, max) {
  const raw = env[name] ?? fallback;
  assert.match(String(raw), /^\d+$/, `${name} must be an integer`);
  const number = Number(raw);
  assert.ok(number >= min && number <= max, `${name} must be ${min}..${max}`);
  return number;
}

function readSoakConfig(env = process.env) {
  return {
    fixedMs: option(env, "PERF_SOAK_FIXED_MS", 60000, 0, 86400000),
    writeMs: option(env, "PERF_SOAK_WRITE_MS", 120000, 1, 86400000),
    sampleMs: option(env, "PERF_SOAK_SAMPLE_MS", 1000, 250, 60000),
    writeIntervalMs: option(env, "PERF_SOAK_WRITE_INTERVAL_MS", 250, 50, 60000),
    size: option(env, "PERF_SOAK_SIZE", 25, 2, 3000),
  };
}

/** Endpoints and slope of a numeric series; describes, never judges. */
function seriesSummary(values, label) {
  assert.ok(
    values.length > 0 && values.every((v) => Number.isFinite(v) && v >= 0),
    `invalid ${label} series`,
  );
  return {
    first: values[0],
    last: values.at(-1),
    min: Math.min(...values),
    max: Math.max(...values),
    deltaBytes: values.at(-1) - values[0],
    slopeBytesPerSample: (values.at(-1) - values[0]) / (values.length - 1),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeToken(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1679616).toString(36)}`;
}

async function runSoak({ config, directory, output, sampleDelayMs = 0, simulateWriteFailure = false } = {}) {
  const report = {
    schemaVersion: 1,
    kind: "soak",
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
    diagnostics: { sampleDelayMs, simulateWriteFailure },
    methodology: {
      topology: "one HTTP server worker process seeded once; load is driven over loopback HTTP",
      phases:
        "fixed phase issues reads only; write phase adds paced POST /context writes on an independent loop (one interval after each completion) so slow sampling cannot starve them",
      sampling:
        "worker CPU/memory/counts/storage via IPC snapshot each sample tick; coordinator RSS and active handles recorded alongside; the sampler sleeps until the next due tick instead of polling (idleWakeups counts wakes that found nothing due)",
      memory: "RSS/heap from process.memoryUsage; sawtooth reflects GC, monotone trends need data-growth context",
      wal: "wal_autocheckpoint(1000 pages) plus the 64MB/30s monitor bound the WAL; walBytes is the sampled file size",
      integrity: "acknowledged write ids must be unique and match the final context row count; FTS marker checks cover all writes up to the 500-row query limit, else a sample",
      scope: "single-machine observation; no thresholds or leak verdicts are derived from one run",
    },
    phases: {
      fixed: { configuredMs: config.fixedMs, reads: { succeeded: 0, unexpected: 0 }, idleWakeups: 0 },
      write: {
        configuredMs: config.writeMs,
        reads: { succeeded: 0, unexpected: 0 },
        writes: { attempted: 0, succeeded: 0, expectedLock: 0, unexpected: 0, unexpectedErrors: [] },
        idleWakeups: 0,
      },
    },
    timeSeries: [],
    analysis: null,
    integrity: null,
  };
  const ownDirectory = !directory;
  const dir = directory ?? mkdtempSync(join(tmpdir(), "conflux-soak-"));
  const env = isolatedEnvironment(dir);
  const readPaths = [
    "/healthz",
    "/graph?status=all",
    "/messages?limit=50",
    "/context/query?query=needle&limit=25",
  ];
  let readIndex = 0;
  const server = fork(
    join(__dirname, "server-worker.cjs"),
    [JSON.stringify({ directory: dir, size: config.size, samples: 20, warmup: 1 })],
    { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const serverExited = new Promise((resolve) => server.once("exit", resolve));
  let agent = null;
  let terminated = false;
  const onTerminate = () => {
    terminated = true;
    server.kill();
  };
  process.once("SIGINT", onTerminate);
  process.once("SIGTERM", onTerminate);
  const deadline = setTimeout(onTerminate, config.fixedMs + config.writeMs + 300000);
  let commandId = 0;
  const rpc = (command, timeoutMs = 30000) => {
    const id = ++commandId;
    return waitMessage(server, { id, ...command }, (m) => m.id === id, timeoutMs);
  };
  const runToken = makeToken("soakw");
  const acknowledgedIds = [];
  report.acknowledgedWriteIds = acknowledgedIds;

  async function readOnce(phase) {
    const path = readPaths[readIndex++ % readPaths.length];
    try {
      await requestJson(url + path, { agent });
      report.phases[phase].reads.succeeded++;
    } catch (error) {
      report.phases[phase].reads.unexpected++;
      report.phases[phase].lastReadError = error.message;
    }
  }

  async function writeOnce(index) {
    const writes = report.phases.write.writes;
    // Regression hook: simulates a harness that fails to deliver any
    // write, proving the non-zero write requirement rejects such a run.
    if (simulateWriteFailure) {
      writes.attempted++;
      return;
    }
    // Zero-padded so each write gets a fixed-length FTS token; prefix
    // queries then match exactly one row instead of numeric prefixes
    // like "5" also hitting "54".
    const marker = `${runToken}${String(index).padStart(8, "0")}`;
    writes.attempted++;
    try {
      const response = await requestJson(url + "/context", {
        agent,
        body: {
          title: `Soak ${marker}`,
          content: `${marker} continuous write`,
          tags: ["soak"],
        },
        timeoutMs: 30000,
        acceptStatus: [503],
      });
      if (response.statusCode === 200) {
        writes.succeeded++;
        acknowledgedIds.push(response.json.entry.id);
        return;
      }
      if (response.statusCode === 503 && response.json?.code === "DATA_LOCKED") writes.expectedLock++;
      else {
        writes.unexpected++;
        writes.unexpectedErrors.push(`HTTP ${response.statusCode}`);
      }
    } catch (error) {
      writes.unexpected++;
      writes.unexpectedErrors.push(error.message);
    }
  }

  let url = null;

  async function sample(phase, startedAt) {
    // Regression hook: simulates a slow sampler (e.g. rpc backlog under
    // load) so tests can prove the write pacer survives it.
    if (sampleDelayMs > 0) await sleep(sampleDelayMs);
    const snapshot = await rpc({ command: "snapshot" });
    const memory = process.memoryUsage();
    report.timeSeries.push({
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      phase,
      worker: {
        rss: snapshot.resources.memory.rss,
        heapTotal: snapshot.resources.memory.heapTotal,
        heapUsed: snapshot.resources.memory.heapUsed,
        external: snapshot.resources.memory.external,
        arrayBuffers: snapshot.resources.memory.arrayBuffers,
        cpuUserMs: snapshot.resources.cpu.user / 1000,
        cpuSystemMs: snapshot.resources.cpu.system / 1000,
        maxRssBytes: snapshot.resources.lifetimeMaxRssBytes,
      },
      coordinator: { rss: memory.rss, heapUsed: memory.heapUsed },
      storage: snapshot.storage,
      counts: snapshot.counts,
      activeHandles:
        typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : null,
    });
  }

  async function runPhase(phase, durationMs) {
    const startedAt = Date.now();
    const endAt = startedAt + durationMs;
    const phaseStats = report.phases[phase];
    let writeIndex = 0;
    const sampler = async () => {
      let nextSample = startedAt;
      while (!terminated && Date.now() < endAt) {
        const now = Date.now();
        if (now >= nextSample) {
          nextSample += config.sampleMs;
          await sample(phase, startedAt);
          await readOnce(phase);
          continue;
        }
        // Sleep until the tick is due (bounded so interruption stays
        // responsive) — polling the clock in a tight loop burned CPU for
        // nothing in the fixed phase.
        phaseStats.idleWakeups++;
        await sleep(Math.max(1, Math.min(5000, nextSample - Date.now())));
      }
    };
    // The write pacer runs on its own loop so a slow sample can never
    // starve the paced write load; cadence resumes one interval after each
    // completion, which skips missed slots instead of bursting.
    const pacer =
      phase === "write"
        ? async () => {
            while (!terminated && Date.now() < endAt) {
              await writeOnce(writeIndex++);
              await sleep(Math.max(1, config.writeIntervalMs));
            }
          }
        : null;
    await (pacer ? Promise.all([sampler(), pacer()]) : sampler());
  }

  async function stopServer() {
    if (server.exitCode !== null || server.signalCode !== null) return;
    try {
      await rpc({ command: "stop" }, 15000);
      await Promise.race([serverExited, sleep(5000)]);
    } catch {
      server.kill();
      await Promise.race([serverExited, sleep(10000)]);
    }
    if (server.exitCode === null && server.signalCode === null) server.kill();
  }

  try {
    const ready = await waitMessage(server, null, (m) => m.ready, 60000);
    url = ready.url;
    agent = new Agent({ keepAlive: true, maxSockets: 4 });
    const contextsBefore = ready.before.counts.contexts;
    console.log(`soak server ready on ${url} with ${config.size} synthetic sessions`);
    console.log("soak phase fixed started");
    await runPhase("fixed", config.fixedMs);
    console.log("soak phase write started");
    await runPhase("write", config.writeMs);
    console.log("soak sampling completed");
    const finalSnapshot = await rpc({ command: "snapshot" });

    const writes = report.phases.write.writes;
    const contextsAfter = finalSnapshot.counts.contexts;
    const expectedContexts = contextsBefore + writes.succeeded;
    const uniqueIds = new Set(acknowledgedIds).size;

    // Full-count FTS verification only while the marker set fits one query.
    let ftsVerified = false;
    if (writes.succeeded <= 500) {
      const matched = await requestJson(`${url}/context/query?query=${runToken}&limit=500`, { agent });
      ftsVerified = matched.json.entries.length === writes.succeeded;
    } else {
      const picks = new Set([0, Math.floor(writes.succeeded / 2), writes.succeeded - 1]);
      while (picks.size < 10) picks.add(Math.floor(Math.random() * writes.succeeded));
      ftsVerified = true;
      for (const index of picks) {
        const marker = `${runToken}${String(index).padStart(8, "0")}`;
        const hit = await requestJson(`${url}/context/query?query=${marker}&limit=2`, { agent });
        if (hit.json.entries.length !== 1) ftsVerified = false;
      }
    }
    // A write phase that acknowledged no writes at all must fail the run
    // however correct the row accounting is. Anything above zero is judged
    // only by data reconciliation: a slower pace than the ideal cadence is
    // a machine observation, never an integrity verdict.
    report.integrity = {
      contextsBefore,
      contextsAfter,
      expectedContexts,
      writesAttempted: writes.attempted,
      writesAcknowledged: writes.succeeded,
      uniqueIds,
      ftsVerified,
      passed:
        contextsAfter === expectedContexts &&
        uniqueIds === writes.succeeded &&
        ftsVerified &&
        writes.succeeded >= 1 &&
        writes.unexpected === 0 &&
        report.phases.fixed.reads.unexpected === 0 &&
        report.phases.write.reads.unexpected === 0,
    };

    const series = (pick) => report.timeSeries.map(pick);
    report.analysis = {
      samples: report.timeSeries.length,
      // Ideal pace is context for reading the acknowledged-write count —
      // an observation, never a threshold.
      idealWrites: Math.floor(config.writeMs / config.writeIntervalMs),
      workerRss: seriesSummary(series((s) => s.worker.rss), "workerRss"),
      workerHeapUsed: seriesSummary(series((s) => s.worker.heapUsed), "workerHeapUsed"),
      workerExternal: seriesSummary(series((s) => s.worker.external), "workerExternal"),
      coordinatorRss: seriesSummary(series((s) => s.coordinator.rss), "coordinatorRss"),
      walBytes: seriesSummary(series((s) => s.storage.walBytes), "walBytes"),
      databaseGrowthBytes: finalSnapshot.storage.databaseBytes - ready.before.storage.databaseBytes,
      auditRowsAdded: finalSnapshot.counts.audit - ready.before.counts.audit,
      gcNote:
        "RSS/heap sawtooth reflects garbage collection and cache warm-up; sustained growth must be compared against databaseGrowthBytes and repeated runs before suspecting a leak",
      leakVerdict: "not-assessed",
    };

    assert.equal(terminated, false, "soak run was interrupted");
    if (!report.integrity.passed)
      throw Error(`soak integrity failed: ${JSON.stringify(report.integrity)}`);
    await stopServer();
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = `${error.message}`;
    return report;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", onTerminate);
    process.off("SIGTERM", onTerminate);
    agent?.destroy();
    if (!terminated) await stopServer();
    else server.kill();
    if (ownDirectory) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function main() {
  const config = readSoakConfig();
  const output = resolve(process.env.PERF_SOAK_OUTPUT ?? join(root, "test-results/performance/soak.json"));
  return runSoak({ config, output }).then((report) => {
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
module.exports = { readSoakConfig, seriesSummary, runSoak };
