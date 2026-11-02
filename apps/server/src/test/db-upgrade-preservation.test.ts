import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { listMessages } from "../core/messages.js";
import { queryContext } from "../core/search.js";
import { getRuntimeAgent } from "../core/runtime-agents.js";

// Upgrade preservation across the whole v8 -> current migration chain: an
// old-version database carrying real user data (sessions, messages,
// contexts + FTS, presets, edges, audit rows) must keep every row readable
// through the current business functions after openDb migrates it — not
// merely bump user_version. The fixture mirrors the column set those
// releases actually had; newer columns and tables are what the migration
// must add without touching existing data.
test("v8 database with user data upgrades with every row preserved and searchable", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "muiltchat-upgrade-"));
  const dbPath = join(dataDir, "data.db");
  try {
    const legacy: DB = openDb({ dataDir, dbPath, scope: "global" });
    // Roll the fresh database back to a v8-era shape: drop what did not
    // exist then and strip columns added after v8 (edge_id arrived with
    // v8 itself, so it stays).
    legacy.exec(`
      DROP TABLE message_deliveries;
      DROP TABLE runtime_instances;
      DROP TABLE room_tasks;
      DROP TABLE chat_rooms;
    `);
    const dropIfPresent = (table: string, column: string) => {
      const cols = legacy.pragma(`table_info(${table})`) as { name: string }[];
      if (cols.some((c) => c.name === column))
        legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    };
    dropIfPresent("sessions", "chat_room_id");
    dropIfPresent("messages", "reply_seen_at");
    dropIfPresent("messages", "room_id");
    // Seed through the surviving schema so triggers (context_fts) index
    // the rows exactly as the old release would have.
    legacy.exec(`
      INSERT INTO sessions (id, name, description, status, created_at, last_heartbeat_at, metadata)
        VALUES ('old-asker', 'legacy asker', NULL, 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL),
               ('old-answerer', 'legacy answerer', NULL, 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL);
      INSERT INTO messages (from_session, to_session, question, status, created_at)
        VALUES ('old-asker', 'old-answerer', 'legacy question about release notes', 'replied', '2026-05-02T00:00:00.000Z'),
               ('old-answerer', 'old-asker', 'legacy reply text', 'read', '2026-05-02T00:01:00.000Z');
      INSERT INTO edges (from_session, to_session, weight, last_interact_at)
        VALUES ('old-asker', 'old-answerer', 2, '2026-05-02T00:01:00.000Z');
      INSERT INTO runtime_agents (name, runtime, workdir, model, base_url, api_key, extra_env, instructions, created_at, updated_at)
        VALUES ('legacy preset', 'claude', NULL, 'legacy-model', NULL, 'legacy-key', NULL, 'legacy instructions', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
      INSERT INTO audit_log (ts, caller_session, interface, action)
        VALUES ('2026-05-01T00:00:00.000Z', 'old-asker', 'http', 'legacy_action');
      PRAGMA user_version = 8;
    `);
    const contextId = legacy
      .prepare(
        `INSERT INTO context_entries (session_id, title, content, tags, created_at, updated_at)
         VALUES ('old-asker', 'Legacy findings', 'release notes summary needle', NULL, '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z')`,
      )
      .run().lastInsertRowid;
    stopWalCheckpoint(legacy);
    legacy.close();

    const upgraded = openDb({ dataDir, dbPath, scope: "global" });
    try {
      assert.equal(upgraded.pragma("user_version", { simple: true }), 14);

      const count = (table: string) =>
        (upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      assert.equal(count("sessions"), 2);
      assert.equal(count("messages"), 2);
      // The seeded edge survives with its weight, and the migration also
      // derives the reverse edge from the reply message — both directions
      // exist afterwards, which is the intended v8 edge derivation.
      const seededEdge = upgraded
        .prepare(`SELECT weight FROM edges WHERE from_session = 'old-asker' AND to_session = 'old-answerer'`)
        .get() as { weight: number };
      const derivedEdge = upgraded
        .prepare(`SELECT weight FROM edges WHERE from_session = 'old-answerer' AND to_session = 'old-asker'`)
        .get() as { weight: number } | undefined;
      assert.equal(seededEdge.weight, 2);
      assert.equal(derivedEdge?.weight, 1);
      assert.equal(count("context_entries"), 1);
      assert.equal(count("runtime_agents"), 1);
      assert.equal(count("audit_log"), 1);

      // Business reads work on the preserved data, including FTS search
      // over rows indexed by the old release's triggers.
      const messages = listMessages(upgraded, { limit: 10 });
      assert.equal(messages.length, 2);
      assert.ok(messages.some((m) => m.question === "legacy question about release notes"));

      const hits = queryContext(upgraded, { query: "needle", limit: 5 });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, Number(contextId));
      assert.equal(hits[0].title, "Legacy findings");

      const preset = getRuntimeAgent(upgraded, 1);
      assert.equal(preset?.name, "legacy preset");
      assert.equal(preset?.api_key, "legacy-key");
      assert.equal(preset?.instructions, "legacy instructions");

      // New-chain writes work next to the preserved rows.
      upgraded
        .prepare(
          `INSERT INTO context_entries (session_id, title, content, tags, created_at, updated_at)
           VALUES ('old-answerer', 'Post-upgrade note', 'written after migration', NULL,
                   datetime('now'), datetime('now'))`,
        )
        .run();
      assert.equal(queryContext(upgraded, { query: "after migration", limit: 5 }).length, 1);
    } finally {
      stopWalCheckpoint(upgraded);
      upgraded.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
