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
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const seedDb = openDb({ dataDir, dbPath: join(dataDir, "data.db"), scope: "global" });
  t.after(() => seedDb.close());
  registerSession(seedDb, { id: "s1", name: "one" });
  registerSession(seedDb, { id: "web-console", name: "Web 控制台" });

  const app = await startHttpServer({ port: 0, overrideDataDir: dataDir });
  t.after(() => app.close());

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
