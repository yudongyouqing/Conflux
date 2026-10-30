const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { test } = require("node:test");
const { requestJson } = require("./http-client.cjs");

test("HTTP measurement consumes JSON and rejects errors, corrupt bodies and timeouts", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/hang") return;
    if (req.url === "/bad-status") return res.writeHead(500).end("{}");
    if (req.url === "/bad-json") return res.end("not-json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await requestJson(url)).json, { ok: true });
  await assert.rejects(requestJson(`${url}/bad-status`), /HTTP 500/);
  await assert.rejects(requestJson(`${url}/bad-json`), SyntaxError);
  await assert.rejects(requestJson(`${url}/hang`, { timeoutMs: 25 }), /aborted/i);
});
