const assert = require("node:assert/strict");
const { fork, execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir, cpus, totalmem, platform, release, arch } = require("node:os");
const { join, resolve, dirname } = require("node:path");
const { Agent } = require("node:http");
const { readConfig, runConcurrent, snapshot, resourceDelta } = require("./measurement.cjs");
const { requestJson } = require("./http-client.cjs");
const root = resolve(__dirname, "../..");

function waitMessage(child, send, matches, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) =>
      onError(Error(`Worker exited (code=${code}, signal=${signal})`));
    const onMessage = (message) => {
      if (matches(message)) {
        cleanup();
        message.error ? reject(Error(message.error)) : resolve(message);
      }
    };
    const timer = setTimeout(() => onError(Error("Worker IPC deadline exceeded")), timeoutMs);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null)
      return onExit(child.exitCode, child.signalCode);
    if (send)
      child.send(send, (error) => {
        if (error) onError(error);
      });
  });
}

function isolatedEnvironment(directory) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CONFLUX_|CLAUDE_|CODEX_)/i.test(key)),
  );
  const home = join(directory, "home");
  mkdirSync(home);
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    CODEX_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CONFLUX_WEB_DIST: join(directory, "no-web-assets"),
    CONFLUX_LOG_LEVEL: "info",
    CONFLUX_LOG_FILE: join(directory, "server.log"),
  });
  return env;
}

async function fixture(size, config) {
  const result = { size, status: "running" };
  const directory = mkdtempSync(join(tmpdir(), "conflux-server-perf-"));
  const env = isolatedEnvironment(directory);
  const child = fork(
    join(__dirname, "server-worker.cjs"),
    [JSON.stringify({ directory, size, samples: config.samples, warmup: config.warmup })],
    { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-8000);
  });
  child.on("message", (message) => {
    if (message.failed && message.sqlite) result.sqlite = message.sqlite;
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const deadline = setTimeout(() => child.kill(), 180000);
  const onTerminate = () => child.kill();
  process.once("SIGINT", onTerminate);
  process.once("SIGTERM", onTerminate);
  let commandId = 0;
  const rpc = (command) => {
    const id = ++commandId;
    return waitMessage(child, { id, command }, (m) => m.id === id);
  };
  const agent = new Agent({ keepAlive: true, maxSockets: Math.max(...config.concurrency) });
  let stopped = false;
  try {
    const ready = await waitMessage(child, null, (m) => m.ready);
    console.log(`HTTP ready for ${size} synthetic sessions`);
    const expectedFts = Math.min(25, Math.ceil((size * 2) / 5));
    const workloads = [
      { name: "health", path: "/healthz", check: (v) => assert.equal(v.ok, true) },
      {
        name: "graph",
        path: "/graph?status=all",
        check: (v) => {
          assert.equal(v.nodes.length, size + 1);
          assert.equal(v.edges.length, size);
        },
      },
      {
        name: "messages-list-50",
        path: "/messages?limit=50",
        check: (v) => assert.equal(v.messages.length, Math.min(50, size * 10)),
      },
      {
        name: "context-fts-25",
        path: "/context/query?query=needle&limit=25",
        check: (v) => {
          assert.equal(v.entries.length, expectedFts);
          assert.ok(v.entries.every((e) => e.content.startsWith("needle")));
        },
      },
      {
        name: "context-insert-fts",
        path: "/context",
        body: { title: "Measured HTTP context", content: "measured content", tags: ["synthetic"] },
        check: (v) => {
          assert.ok(v.entry.id > 0);
          assert.equal(v.entry.content, "measured content");
        },
      },
    ];
    result.sqlite = ready.sqlite;
    result.http = { before: ready.before, startupMs: ready.startupMs, cases: [] };
    for (const workload of workloads) {
      for (const concurrency of config.concurrency) {
        const request = () =>
          requestJson(ready.url + workload.path, { agent, body: workload.body });
        const validate = (response) => workload.check(response.json);
        const warm = await runConcurrent(config.warmup, concurrency, request, validate);
        assert.deepEqual(warm.failures, [], `${workload.name} warm-up failed`);
        const before = await rpc("snapshot");
        const clientBefore = snapshot();
        const measured = await runConcurrent(config.samples, concurrency, request, validate);
        const clientAfter = snapshot();
        const after = await rpc("snapshot");
        result.http.cases.push({
          name: workload.name,
          concurrency,
          ...measured,
          serverResources: resourceDelta(before.resources, after.resources),
          clientResources: resourceDelta(clientBefore, clientAfter),
        });
        assert.deepEqual(measured.failures, [], `${workload.name} measured requests failed`);
      }
    }
    const indexed = await requestJson(ready.url + "/context/query?query=measured&limit=25", {
      agent,
    });
    assert.equal(
      indexed.json.entries.length,
      Math.min(25, config.concurrency.length * (config.samples + config.warmup)),
    );
    assert.ok(indexed.json.entries.every((entry) => entry.content === "measured content"));
    const end = await rpc("snapshot");
    result.http.after = { counts: end.counts, storage: end.storage };
    assert.equal(
      end.counts.contexts - ready.before.counts.contexts,
      config.concurrency.length * (config.samples + config.warmup),
    );
    await rpc("stop");
    await exited;
    stopped = true;
    result.status = "passed";
    return result;
  } catch (error) {
    result.status = "failed";
    const failure = Error(
      `Fixture ${size}: ${error.message}${stderr ? `\nWorker stderr: ${stderr}` : ""}`,
      { cause: error },
    );
    failure.partialFixture = result;
    throw failure;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", onTerminate);
    process.off("SIGTERM", onTerminate);
    agent.destroy();
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function main() {
  const config = readConfig();
  const output = resolve(
    process.env.PERF_SERVER_OUTPUT ?? join(root, "test-results/performance/server-database.json"),
  );
  const report = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    source: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty:
        execFileSync(
          "git",
          [
            "status",
            "--porcelain",
            "--",
            "scripts/performance",
            "apps/server",
            "packages/shared",
            "package.json",
            "package-lock.json",
            ".github/workflows/ci.yml",
          ],
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
    methodology: {
      config,
      fixture: "ring; 10 messages and 2 contexts per session; 1/5 of contexts match FTS",
      percentiles: "nearest rank",
      http: "loopback, keep-alive, closed-loop, separate server/client processes; full JSON body and parsing; validation excluded from individual latency",
      logging: "info to isolated temporary file",
      memory: "before/after snapshots and process-lifetime high-water RSS, not per-case peak",
      writes: "autocommit; reads precede inserts; warm-up writes remain in database",
    },
    fixtures: [],
  };
  try {
    for (const size of config.sizes) {
      report.fixtures.push(await fixture(size, config));
      console.log(`Validated ${size} sessions: SQLite and HTTP samples complete`);
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    if (error.partialFixture) report.fixtures.push(error.partialFixture);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(`Report: ${output} (${report.status})`);
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { waitMessage, isolatedEnvironment };
