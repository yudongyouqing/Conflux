const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  assertPortAvailable,
  findPortOwner,
  parseLsofOwner,
  parseNetstatOwner,
  parseTasklistCommand,
} = require("../src/port-diagnostics.cjs");

test("reports an occupied port with its resolved owner", async () => {
  const server = http.createServer((_req, res) => res.end("foreign"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      assertPortAvailable(port, "127.0.0.1", {
        findOwner: async () => ({ pid: 2468, command: "other-service" }),
      }),
      /127\.0\.0\.1:\d+.*2468.*other-service/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reports an occupied port even when its owner cannot be resolved", async () => {
  const server = http.createServer((_req, res) => res.end("foreign"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      assertPortAvailable(port, "127.0.0.1", { findOwner: async () => null }),
      /127\.0\.0\.1:\d+.*unable to resolve owning process/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("resolves Windows netstat and tasklist output into an owner summary", () => {
  const netstat = [
    "  TCP    127.0.0.1:9527    0.0.0.0:0    LISTENING    2468",
    "  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    1357",
  ].join("\r\n");
  assert.deepEqual(parseNetstatOwner(netstat, "127.0.0.1", 9527), { pid: 2468 });

  const tasklist = [
    '"Image Name","PID","Session Name","Session#","Mem Usage"',
    '"node.exe","2468","Console","1","42,000 K"',
  ].join("\r\n");
  assert.deepEqual(parseTasklistCommand(tasklist, 2468), { command: "node.exe" });
});

test("resolves POSIX lsof output into an owner summary", async () => {
  assert.deepEqual(parseLsofOwner("p4321\ncnode\nf12\n"), { pid: 4321, command: "node" });
  assert.deepEqual(parseLsofOwner("p9876\n"), { pid: 9876 });
  assert.equal(parseLsofOwner(""), null);

  const owner = await findPortOwner(9527, "127.0.0.1", {
    platform: "darwin",
    execFileFn: (_cmd, _args, _opts, cb) => cb(null, "p4321\ncnode\n", ""),
  });
  assert.deepEqual(owner, { pid: 4321, command: "node" });

  const winOwner = await findPortOwner(9527, "127.0.0.1", {
    platform: "win32",
    execFileFn: (cmd, _args, _opts, cb) => {
      if (cmd === "netstat") {
        cb(null, "  TCP    127.0.0.1:9527    0.0.0.0:0    LISTENING    2468\r\n", "");
      } else {
        cb(null, '"node.exe","2468","Console","1","42,000 K"\r\n', "");
      }
    },
  });
  assert.deepEqual(winOwner, { pid: 2468, command: "node.exe" });
});
