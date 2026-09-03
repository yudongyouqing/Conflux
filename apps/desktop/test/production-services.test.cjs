const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");

const {
  createProductionServiceSpec,
  waitForProductionService,
} = require("../src/production-services.cjs");

function pendingChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  return child;
}

test("uses Electron as Node and passes packaged server configuration", () => {
  const inheritedEnv = { PATH: "C:\\Windows\\System32", KEEP_ME: "yes" };
  const spec = createProductionServiceSpec(
    {
      serverEntry: "C:\\app.asar\\apps\\server\\dist\\index.js",
      webDist: "C:\\app.asar\\apps\\web\\dist",
      dataDir: "C:\\Users\\me\\.muiltchat",
    },
    {
      execPath: "C:\\Program Files\\Conflux\\Conflux.exe",
      env: inheritedEnv,
    }
  );

  assert.equal(spec.command, "C:\\Program Files\\Conflux\\Conflux.exe");
  assert.deepEqual(spec.args, [
    "C:\\app.asar\\apps\\server\\dist\\index.js",
    "serve",
  ]);
  assert.equal(spec.url, "http://127.0.0.1:9527/healthz");
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spec.env.MUILTCHAT_WEB_DIST, "C:\\app.asar\\apps\\web\\dist");
  assert.equal(spec.env.MUILTCHAT_HOST, "127.0.0.1");
  assert.equal(spec.env.MUILTCHAT_PORT, "9527");
  assert.equal(spec.env.MUILTCHAT_HOME, "C:\\Users\\me\\.muiltchat");
  assert.equal(spec.env.KEEP_ME, "yes");
  assert.equal(Object.hasOwn(spec, "cwd"), false);
});

test("allows the packaged server health check to be cancelled", async () => {
  const child = pendingChild();
  const controller = new AbortController();
  const spec = {
    name: "server",
    url: "http://127.0.0.1:1/never-ready",
  };

  const pending = waitForProductionService(spec, child, {
    timeoutMs: 5_000,
    intervalMs: 10,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, /Aborted waiting for http:\/\/127\.0\.0\.1:1\/never-ready/);
});

test("rejects an exited packaged server even when another service answers", async () => {
  const foreignServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => foreignServer.listen(0, "127.0.0.1", resolve));

  try {
    const port = foreignServer.address().port;
    const child = pendingChild();
    const spec = {
      name: "server",
      url: `http://127.0.0.1:${port}/healthz`,
    };
    const pending = waitForProductionService(spec, child, {
      timeoutMs: 500,
      intervalMs: 10,
    });

    child.exitCode = 1;
    child.emit("exit", 1, null);

    await assert.rejects(
      pending,
      /server exited before becoming ready \(code 1\)/
    );
  } finally {
    await new Promise((resolve) => foreignServer.close(resolve));
  }
});

test("rejects when the packaged server exits immediately after health resolves", async () => {
  const child = pendingChild();
  const spec = {
    name: "server",
    url: "http://127.0.0.1:1/healthz",
  };

  const pending = waitForProductionService(spec, child, {
    timeoutMs: 50,
    waitForHttpFn: async () => {
      setImmediate(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
    },
  });

  await assert.rejects(
    pending,
    /server exited before becoming ready \(code 1\)/
  );
});
