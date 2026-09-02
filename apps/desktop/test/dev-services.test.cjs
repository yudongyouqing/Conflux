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
  });
});

test("creates IPv4 service specs rooted at the repository", () => {
  const specs = createDevServiceSpecs("C:\\repo");

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

test("declares the host and port for every development service", () => {
  const specs = createDevServiceSpecs("C:\\repo");
  assert.deepEqual(
    specs.map(({ name, host, port }) => ({ name, host, port })),
    [
      { name: "server", host: "127.0.0.1", port: 9527 },
      { name: "web", host: "127.0.0.1", port: 5173 },
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

test("stopChild uses taskkill once on Windows", () => {
  const calls = [];
  const child = { pid: 2468, killed: false, exitCode: null, kill() {} };
  const spawnFn = (...args) => calls.push(args);

  stopChild(child, { platform: "win32", spawnFn });
  stopChild(child, { platform: "win32", spawnFn });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "taskkill",
    ["/pid", "2468", "/T", "/F"],
    { windowsHide: true, stdio: "ignore" },
  ]);
});

test("stopChild sends SIGTERM once on non-Windows", () => {
  const signals = [];
  const child = {
    pid: 2468,
    killed: false,
    exitCode: null,
    kill: (signal) => signals.push(signal),
  };

  stopChild(child, { platform: "linux", spawnFn: () => assert.fail("must not spawn") });
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
