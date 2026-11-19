const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");

const {
  createDevServiceSpecs,
  createDevServiceSpawnOptions,
  assertDevServicePorts,
  stopChild,
  waitForService,
  waitForHttp,
  createServiceRuntimeGuard,
} = require("../src/dev-services.cjs");

test("uses pipe-safe stdio for Electron child processes", () => {
  const env = { PATH: "C:\\tools" };

  assert.deepEqual(createDevServiceSpawnOptions("C:\\repo", env), {
    cwd: "C:\\repo",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
});

test("creates IPv4 service specs rooted at the repository", () => {
  const specs = createDevServiceSpecs("C:\\repo", {
    nodeExecPath: "",
    npmExecPath: "",
  });

  assert.deepEqual(
    specs.map(({ name, command, args, cwd, url }) => ({
      name,
      command,
      args,
      cwd,
      url,
    })),
    [
      {
        name: "server",
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["run", "serve", "-w", "apps/server"],
        cwd: "C:\\repo",
        url: "http://127.0.0.1:9527/healthz",
      },
      {
        name: "web",
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: [
          "run",
          "dev",
          "-w",
          "apps/web",
          "--",
          "--host",
          "127.0.0.1",
          "--strictPort",
        ],
        cwd: "C:\\repo",
        url: "http://127.0.0.1:5173/",
      },
    ]
  );
});

test("runs the npm CLI directly on Windows when npm provides its CLI path", () => {
  const specs = createDevServiceSpecs("C:\\repo", {
    platform: "win32",
    nodeExecPath: "C:\\node\\node.exe",
    npmExecPath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
  });

  assert.equal(specs[0].command, "C:\\node\\node.exe");
  assert.deepEqual(specs[0].args, [
    "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
    "run",
    "serve",
    "-w",
    "apps/server",
  ]);
  assert.equal(specs[0].shell, false);
});

test("declares the host and port for every development service", () => {
  const specs = createDevServiceSpecs("C:\\repo");
  assert.deepEqual(
    specs.map(({ name, host, port, startupTimeoutMs }) => ({
      name,
      host,
      port,
      startupTimeoutMs,
    })),
    [
      {
        name: "server",
        host: "127.0.0.1",
        port: 9527,
        startupTimeoutMs: 120_000,
      },
      {
        name: "web",
        host: "127.0.0.1",
        port: 5173,
        startupTimeoutMs: 120_000,
      },
    ]
  );
});

test("checks every development port before services are spawned", async () => {
  const checked = [];
  await assertDevServicePorts(createDevServiceSpecs("C:\\repo"), {
    assertPortAvailableFn: async (port, host) => checked.push({ port, host }),
  });
  assert.deepEqual(checked, [
    { port: 9527, host: "127.0.0.1" },
    { port: 5173, host: "127.0.0.1" },
  ]);
});

test("stops port preflight at the first conflict", async () => {
  const checked = [];
  await assert.rejects(
    assertDevServicePorts(createDevServiceSpecs("C:\\repo"), {
      assertPortAvailableFn: async (port, host) => {
        checked.push({ port, host });
        if (port === 9527) throw new Error("server port is occupied");
      },
    }),
    /server port is occupied/
  );
  assert.deepEqual(checked, [{ port: 9527, host: "127.0.0.1" }]);
});

test("stopChild uses taskkill once on Windows", async () => {
  const calls = [];
  const child = { pid: 2468, killed: false, exitCode: null, kill() {} };
  const spawnFn = (...args) => {
    calls.push(args);
    const killer = new EventEmitter();
    process.nextTick(() => killer.emit("exit", 0));
    return killer;
  };

  await Promise.all([
    stopChild(child, { platform: "win32", spawnFn }),
    stopChild(child, { platform: "win32", spawnFn }),
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "taskkill",
    ["/pid", "2468", "/T", "/F"],
    { windowsHide: true, stdio: "ignore" },
  ]);
});

test("stopChild waits for Windows process-tree cleanup even after the shell exits", async () => {
  const calls = [];
  const child = { pid: 1357, killed: true, exitCode: 0, kill() {} };
  let finishTaskkill;
  const spawnFn = (...args) => {
    calls.push(args);
    const killer = new EventEmitter();
    finishTaskkill = () => killer.emit("exit", 0);
    return killer;
  };

  let settled = false;
  const stopping = stopChild(child, { platform: "win32", spawnFn }).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(calls.length, 1);
  finishTaskkill();
  await stopping;
  assert.equal(settled, true);
});

test("stopChild sends SIGTERM once on non-Windows", () => {
  const signals = [];
  const child = {
    pid: 2468,
    killed: false,
    exitCode: null,
    kill: (signal) => signals.push(signal),
  };

  stopChild(child, { platform: "linux", killFn: (_pid, signal) => signals.push(signal), spawnFn: () => assert.fail("must not spawn") });
  stopChild(child, { platform: "linux", spawnFn: () => assert.fail("must not spawn") });

  assert.deepEqual(signals, ["SIGTERM"]);
});

test("waitForHttp resolves when a local service responds", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address.port;

  await assert.doesNotReject(
    waitForHttp(`http://127.0.0.1:${port}/`, {
      timeoutMs: 500,
      intervalMs: 10,
    })
  );

  await new Promise((resolve) => server.close(resolve));
});

test("waitForHttp rejects with the URL after its timeout", async () => {
  const url = "http://127.0.0.1:1/never-ready";

  await assert.rejects(
    waitForHttp(url, { timeoutMs: 40, intervalMs: 10 }),
    (error) => error instanceof Error && error.message === `Timed out waiting for ${url}`
  );
});

test("waitForService rejects promptly when its child exits before readiness", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  const spec = {
    name: "web",
    url: "http://127.0.0.1:1/never-ready",
  };

  const pending = waitForService(spec, child, {
    timeoutMs: 5_000,
    intervalMs: 10,
    exitProbeTimeoutMs: 20,
  });
  child.exitCode = 1;
  child.emit("exit", 1, null);

  await assert.rejects(
    pending,
    (error) => error instanceof Error && error.message.includes("web exited before becoming ready")
  );
});

test("waitForService rejects when startup is aborted", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  const controller = new AbortController();
  const spec = {
    name: "web",
    url: "http://127.0.0.1:1/never-ready",
  };

  const pending = waitForService(spec, child, {
    timeoutMs: 40,
    intervalMs: 5,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error instanceof Error && error.message === "Aborted waiting for web"
  );
});

test("runtime child failures are ignored before readiness and during shutdown", () => {
  let servicesReady = false;
  let isQuitting = false;
  const failures = [];
  const guard = createServiceRuntimeGuard({
    isServicesReady: () => servicesReady,
    isQuitting: () => isQuitting,
    onFailure: (failure) => failures.push(failure),
  });

  assert.equal(guard.handleChildExit({ name: "web" }, 1, null), false);
  servicesReady = true;
  assert.equal(guard.handleChildExit({ name: "web" }, 1, null), true);
  assert.equal(guard.handleChildExit({ name: "server" }, 1, "SIGTERM"), false);
  isQuitting = true;
  assert.equal(guard.handleChildExit({ name: "server" }, 1, null), false);

  assert.deepEqual(failures, [
    {
      type: "child-exit",
      name: "web",
      reason: "code 1",
    },
  ]);
});

test("runtime health failure is reported once and recovery does not fail the app", () => {
  let servicesReady = true;
  let isQuitting = false;
  const failures = [];
  const guard = createServiceRuntimeGuard({
    isServicesReady: () => servicesReady,
    isQuitting: () => isQuitting,
    onFailure: (failure) => failures.push(failure),
  });

  assert.equal(guard.handleHealthState({ name: "server", state: "degraded" }), false);
  assert.equal(guard.handleHealthState({ name: "server", state: "unhealthy" }), true);
  assert.equal(guard.handleHealthState({ name: "server", state: "healthy" }), false);
  assert.equal(guard.handleHealthState({ name: "server", state: "unhealthy" }), false);

  assert.deepEqual(failures, [
    {
      type: "health",
      name: "server",
      reason: "health state unhealthy",
    },
  ]);

  servicesReady = false;
  isQuitting = false;
  assert.equal(guard.handleHealthState({ name: "web", state: "unhealthy" }), false);
});


test("waitForHttp retries HTTP errors until a healthy response arrives", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(++calls < 3 ? 503 : 200);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await waitForHttp(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 500, intervalMs: 5 });
    assert.equal(calls, 3);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("waitForHttp times out even when a connected server never sends headers", async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(waitForHttp(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 40, signal: controller.signal }), /Timed out waiting/);
  } finally { clearTimeout(guard); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});


test("POSIX shutdown waits for exit instead of returning after SIGTERM", async () => {
  const child = new EventEmitter();
  child.pid = 1234; child.exitCode = null;
  child.kill = () => true;
  let settled = false;
  const stopping = stopChild(child, { platform: "linux", killFn: (_pid, signal) => { if (signal === 0 && child.exitCode !== null) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; } }).then(() => { settled = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false);
  child.exitCode = 0; child.emit("exit", 0); await stopping;
  assert.equal(settled, true);
});

test("POSIX shutdown terminates an owned process group and escalates on timeout", async () => {
  const child = new EventEmitter();
  child.pid = 1235; child.exitCode = null;
  child.kill = () => assert.fail("must stop the detached process group");
  const signals = [];
  await stopChild(child, { platform: "linux", timeoutMs: 10, killFn: (pid, signal) => { signals.push([pid, signal]); } });
  assert.deepEqual(signals, [[-1235, "SIGTERM"], [-1235, "SIGKILL"]]);
});


test("POSIX shutdown keeps waiting for descendants after the shell exits", async () => {
  const child = new EventEmitter(); child.pid = 1236; child.exitCode = null;
  let alive = true; let settled = false;
  const stopping = stopChild(child, { platform: "linux", timeoutMs: 500, killFn: (_pid, signal) => {
    if (signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  } }).then(() => { settled = true; });
  child.exitCode = 0; child.emit("exit", 0);
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false);
  alive = false; await stopping;
});
