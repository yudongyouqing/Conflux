const assert = require("node:assert/strict");
const { fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { isolatedEnvironment, waitMessage } = require("./server-database.cjs");

test("real worker exits when its coordinator disconnects", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "conflux-perf-disconnect-test-"));
  const child = fork(
    join(__dirname, "server-worker.cjs"),
    [JSON.stringify({ directory, size: 2, samples: 20, warmup: 1 })],
    { env: isolatedEnvironment(directory), stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  try {
    await waitMessage(child, null, (m) => m.ready);
    child.disconnect();
    const [code] = await exited;
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test(
  "coordinator termination exits; catchable SIGTERM writes failure and cleans its fixture",
  { timeout: 20000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "conflux-perf-signal-test-"));
    const temp = join(directory, "tmp");
    mkdirSync(temp);
    const output = join(directory, "report.json");
    const child = spawn(process.execPath, [join(__dirname, "server-database.cjs")], {
      env: {
        ...process.env,
        TEMP: temp,
        TMP: temp,
        TMPDIR: temp,
        PERF_SERVER_OUTPUT: output,
        PERF_SERVER_SIZES: "8",
        PERF_SERVER_SAMPLES: "20",
        PERF_SERVER_WARMUP: "1",
        PERF_SERVER_CONCURRENCY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    try {
      await new Promise((resolve, reject) => {
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes("HTTP ready")) resolve();
        });
        child.once("exit", () => reject(Error("coordinator exited before readiness")));
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      // Windows terminates immediately; POSIX delivers a catchable signal.
      if (process.platform === "win32") assert.equal(signal, "SIGTERM");
      else {
        assert.equal(code, 1);
        assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "failed");
        assert.deepEqual(readdirSync(temp), []);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      // An uncatchable Windows termination is covered by worker disconnect above.
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
