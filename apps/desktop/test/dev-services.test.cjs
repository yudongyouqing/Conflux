const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  createDevServiceSpecs,
  waitForHttp,
} = require("../src/dev-services.cjs");

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
        args: ["run", "dev", "-w", "apps/web", "--", "--host", "127.0.0.1"],
        cwd: "C:\\repo",
        url: "http://127.0.0.1:5173/",
      },
    ]
  );
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
