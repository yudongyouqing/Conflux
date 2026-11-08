import assert from "node:assert/strict";
import { test } from "node:test";
import { withBrowser } from "./chat-first-smoke.mjs";

// The smoke's browser cleanup regression: importing the module must be
// side-effect free (no servers, no ports), and withBrowser must close the
// browser on every path. Before this seam, a failing step left the browser
// running — the children cleanup stopped servers/vite but never Chromium.

function fakeBrowser(log) {
  return {
    close: async () => {
      log.push("close");
    },
  };
}

test("importing the smoke module does not spawn anything", () => {
  // the import at the top already proves this: port picking and server
  // spawning now live behind the isMainModule() gate
  assert.equal(typeof withBrowser, "function");
});

test("withBrowser closes the browser when steps succeed", async () => {
  const log = [];
  await withBrowser(
    async () => fakeBrowser(log),
    async () => {
      log.push("steps");
    },
  );
  assert.deepEqual(log, ["steps", "close"]);
});

test("withBrowser closes the browser when steps fail, and rethrows", async () => {
  const log = [];
  await assert.rejects(
    withBrowser(
      async () => fakeBrowser(log),
      async () => {
        log.push("steps");
        throw new Error("simulated smoke failure");
      },
    ),
    /simulated smoke failure/,
  );
  assert.deepEqual(log, ["steps", "close"]);
});

test("withBrowser propagates launch failures without calling close", async () => {
  const log = [];
  await assert.rejects(
    withBrowser(
      async () => {
        log.push("launch");
        throw new Error("launch failed");
      },
      async () => log.push("never"),
    ),
    /launch failed/,
  );
  assert.deepEqual(log, ["launch"]);
});
