import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.js";
import { registerSession } from "../core/sessions.js";
import { startHttpServer } from "../http/server.js";

test("GET /data/counts + POST /data/clear round-trip", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "muiltchat-http-clear-"));

  const seedDb = openDb({ dataDir, dbPath: join(dataDir, "data.db"), scope: "global" });
  registerSession(seedDb, { id: "s1", name: "one" });
  registerSession(seedDb, { id: "web-console", name: "Web 控制台" });

  // node:test runs t.after hooks in REGISTRATION order (FIFO), and a
  // throwing hook skips every hook after it — so the db and the server
  // (which holds its own connection) must close before the directory
  // delete (Windows: deleting an open data.db gives EBUSY), and the
  // delete itself must never throw.
  t.after(() => seedDb.close());

  const app = await startHttpServer({ port: 0, overrideDataDir: dataDir });
  t.after(() => app.close());
  t.after(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // disposable temp dir — leave it behind rather than fail the test
    }
  });

  const counts = await app.inject({ method: "GET", url: "/data/counts" });
  assert.equal(counts.statusCode, 200);
  assert.deepEqual(counts.json(), { sessions: 1, messages: 0, contextEntries: 0 });

  const cleared = await app.inject({
    method: "POST",
    url: "/data/clear",
    payload: { categories: { sessions: true } },
  });
  assert.equal(cleared.statusCode, 200);
  const body = cleared.json();
  assert.equal(body.cleared.sessions, 1);
  assert.ok(String(body.backupPath).startsWith(join(dataDir, "backups")));

  const afterClear = await app.inject({ method: "GET", url: "/data/counts" });
  assert.deepEqual(afterClear.json(), { sessions: 0, messages: 0, contextEntries: 0 });

  const bad = await app.inject({
    method: "POST",
    url: "/data/clear",
    payload: { categories: {} },
  });
  assert.equal(bad.statusCode, 400);
});
