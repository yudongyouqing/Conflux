const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  createServiceHealthMonitor,
  probeHttp,
} = require("../src/service-health.cjs");

function fakeTimer() {
  let callback;
  let cleared = false;

  return {
    setIntervalFn: (fn) => {
      callback = fn;
      return { unref() {} };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
    run() {
      return callback?.();
    },
    wasCleared: () => cleared,
  };
}

test("marks a service healthy after a successful probe", async () => {
  const timer = fakeTimer();
  const states = [];
  let calls = 0;
  const monitor = createServiceHealthMonitor({
    name: "server",
    probe: async () => {
      calls += 1;
      return true;
    },
    intervalMs: 10,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    onStateChange: (snapshot) => states.push(snapshot),
  });

  await monitor.start();
  assert.equal(calls, 1);
  assert.equal(monitor.snapshot().state, "healthy");
  assert.equal(states.at(-1).name, "server");
  await timer.run();
  assert.equal(calls, 2);
});

test("requires two consecutive failures before unhealthy", async () => {
  const timer = fakeTimer();
  const results = [false, false];
  const monitor = createServiceHealthMonitor({
    name: "web",
    probe: async () => results.shift(),
    intervalMs: 10,
    failureThreshold: 2,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    onStateChange: () => {},
  });

  await monitor.start();
  assert.equal(monitor.snapshot().state, "degraded");
  assert.equal(monitor.snapshot().consecutiveFailures, 1);
  await timer.run();
  assert.equal(monitor.snapshot().state, "unhealthy");
  assert.equal(monitor.snapshot().consecutiveFailures, 2);
});

test("recovers to healthy and resets failures after a successful probe", async () => {
  const timer = fakeTimer();
  const results = [false, false, true];
  const states = [];
  const monitor = createServiceHealthMonitor({
    name: "server",
    probe: async () => results.shift(),
    intervalMs: 10,
    failureThreshold: 2,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    onStateChange: (snapshot) => states.push(snapshot),
  });

  await monitor.start();
  await timer.run();
  await timer.run();

  assert.equal(monitor.snapshot().state, "healthy");
  assert.equal(monitor.snapshot().consecutiveFailures, 0);
  assert.equal(states.at(-1).reason, "probe-recovered");
});

test("does not overlap probes while a previous probe is pending", async () => {
  const timer = fakeTimer();
  let resolveProbeStarted;
  const probeStarted = new Promise((resolve) => {
    resolveProbeStarted = resolve;
  });
  let releaseProbe;
  let calls = 0;
  const monitor = createServiceHealthMonitor({
    name: "server",
    probe: () => {
      calls += 1;
      resolveProbeStarted();
      return new Promise((resolve) => {
        releaseProbe = resolve;
      });
    },
    intervalMs: 10,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    onStateChange: () => {},
  });

  const first = monitor.start();
  await probeStarted;
  const second = timer.run();
  assert.equal(calls, 1);
  assert.equal(second, first);

  releaseProbe(true);
  await first;
  assert.equal(monitor.snapshot().state, "healthy");
});

test("stops scheduling and ignores a probe that resolves later", async () => {
  const timer = fakeTimer();
  let releaseProbe;
  let calls = 0;
  const monitor = createServiceHealthMonitor({
    name: "web",
    probe: () => {
      calls += 1;
      return new Promise((resolve) => {
        releaseProbe = resolve;
      });
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    onStateChange: () => {},
  });

  const pending = monitor.start();
  await monitor.stop();
  releaseProbe(false);
  await pending;
  await timer.run();

  assert.equal(timer.wasCleared(), true);
  assert.equal(calls, 1);
  assert.equal(monitor.snapshot().state, "stopped");
});

test("probeHttp accepts successful and redirect responses only", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/ok" });
      response.end();
      return;
    }
    if (request.url === "/failure") {
      response.writeHead(503);
      response.end();
      return;
    }
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    assert.equal(await probeHttp(`http://127.0.0.1:${port}/ok`, 100), true);
    assert.equal(await probeHttp(`http://127.0.0.1:${port}/redirect`, 100), true);
    assert.equal(await probeHttp(`http://127.0.0.1:${port}/failure`, 100), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("probeHttp treats connection errors and timeouts as failures", async () => {
  assert.equal(await probeHttp("http://127.0.0.1:1/not-running", 30), false);

  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    assert.equal(await probeHttp(`http://127.0.0.1:${port}/hang`, 30), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
