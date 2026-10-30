import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, stopWalCheckpoint } from "../core/db.js";
import { registerSession } from "../core/sessions.js";
import { askSession, getMessage } from "../core/messages.js";
import { createRuntimeAgent, getRuntimeAgent } from "../core/runtime-agents.js";

test("schema 13 upgrades preserve existing messages and presets without invented delivery history", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-controls-migration-"));
  const config = { dataDir, dbPath: join(dataDir, "data.db"), scope: "global" as const };
  let db = openDb(config);
  try {
    registerSession(db, { id: "old-sender", name: "sender" });
    registerSession(db, { id: "old-recipient", name: "recipient" });
    const message = askSession(db, {
      from_session: "old-sender",
      to_session: "old-recipient",
      question: "preserve me",
    });
    const preset = createRuntimeAgent(db, {
      name: "old preset",
      runtime: "codex",
      api_key: "existing-local-credential",
    });
    db.exec("DROP TABLE message_deliveries; DROP TABLE runtime_instances;");
    db.pragma("user_version = 13");
    stopWalCheckpoint(db);
    db.close();
    db = openDb(config);
    assert.equal(db.pragma("user_version", { simple: true }), 14);
    assert.equal(getMessage(db, message.id)?.question, "preserve me");
    assert.equal(getMessage(db, message.id)?.delivery, undefined);
    assert.equal(getRuntimeAgent(db, preset.id)?.api_key, "existing-local-credential");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM runtime_instances").get() as { n: number }).n,
      0,
    );
  } finally {
    stopWalCheckpoint(db);
    db.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
