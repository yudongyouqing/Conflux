import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import {
  claimNextQueuedRun,
  enqueueManagedTask,
  replaceManagedBindingOwner,
  updateManagedRun,
  upsertManagedBinding,
  type ManagedRunRow,
} from "../core/managed-codex/store.js";
import type { ManagedTaskInput } from "../core/managed-codex/types.js";

// Managed-codex persistence invariants: enqueue is idempotent per message,
// only one scheduler can move a queued run to submitting, and run mutations
// are conditional on the instance binding's CURRENT owner token so a stale
// manager generation can never complete a task that recovery handed to a
// new owner.

function seed(): { db: DB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-store-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  return { db, dir };
}

function cleanup(db: DB, dir: string): void {
  stopWalCheckpoint(db);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

/** Insert a real sender/recipient/message pair and return the message id. */
function insertMessage(db: DB, question = "fixture task text"): number {
  db.exec(`
    INSERT OR IGNORE INTO sessions (id, name, description, status, created_at, last_heartbeat_at)
      VALUES ('asker', 'asker', NULL, 'active', '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z'),
             ('managed-1', 'managed executor', NULL, 'active', '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z');
    INSERT INTO messages (from_session, to_session, question, status, created_at)
      VALUES ('asker', 'managed-1', '${question.replace(/'/g, "''")}', 'pending', '2026-11-12T00:00:01.000Z');
  `);
  return Number(
    (db.prepare(`SELECT id FROM messages WHERE question = ?`).get(question) as { id: number }).id,
  );
}

function binding(db: DB, instanceId = "inst-1", ownerToken = randomUUID()): string {
  upsertManagedBinding(db, {
    instanceId,
    sessionId: "managed-1",
    threadId: "thread-fixture-1",
    ownerToken,
  });
  return ownerToken;
}

function task(messageId: number, instanceId = "inst-1"): ManagedTaskInput {
  return { messageId, instanceId, text: "fixture task text" };
}

test("enqueueManagedTask is idempotent per message: same run, one row", () => {
  const { db, dir } = seed();
  try {
    const owner = binding(db);
    const messageId = insertMessage(db);
    const first = enqueueManagedTask(db, task(messageId));
    const second = enqueueManagedTask(db, task(messageId));
    assert.equal(first.id, second.id);
    const count = db.prepare("SELECT COUNT(*) AS n FROM managed_codex_runs").get() as {
      n: number;
    };
    assert.equal(count.n, 1);
    assert.equal(first.state, "queued");
    assert.equal(first.message_id, messageId);
    assert.equal(first.submit_text, "fixture task text");
    assert.ok(owner); // binding fixture used
  } finally {
    cleanup(db, dir);
  }
});

test("enqueue for a message already owned by another instance conflicts", () => {
  const { db, dir } = seed();
  try {
    binding(db);
    const messageId = insertMessage(db);
    enqueueManagedTask(db, task(messageId));
    assert.throws(
      () => enqueueManagedTask(db, { messageId, instanceId: "inst-other", text: "x" }),
      /already bound/,
    );
    const count = db.prepare("SELECT COUNT(*) AS n FROM managed_codex_runs").get() as {
      n: number;
    };
    assert.equal(count.n, 1);
  } finally {
    cleanup(db, dir);
  }
});

test("enqueue rejects unknown messages instead of inventing work", () => {
  const { db, dir } = seed();
  try {
    binding(db);
    assert.throws(() => enqueueManagedTask(db, task(999999)), /message not found/);
  } finally {
    cleanup(db, dir);
  }
});

test("only one scheduler moves a queued run to submitting", () => {
  const { db, dir } = seed();
  try {
    const owner = binding(db);
    const messageId = insertMessage(db);
    enqueueManagedTask(db, task(messageId));
    const first = claimNextQueuedRun(db, { instanceId: "inst-1", ownerToken: owner });
    assert.ok(first, "the first claimant must win the queued run");
    assert.equal(first.state, "submitting");
    assert.ok(first.request_id, "claiming assigns the request id used for turn/start");
    const second = claimNextQueuedRun(db, { instanceId: "inst-1", ownerToken: owner });
    assert.equal(second, null, "nothing is left to claim for the second caller");
    const states = db
      .prepare(`SELECT state FROM managed_codex_runs WHERE id = ?`)
      .all(first.id) as { state: string }[];
    assert.equal(states.length, 1);
    assert.equal(states[0].state, "submitting");
  } finally {
    cleanup(db, dir);
  }
});

test("a claim from a non-owner token is refused", () => {
  const { db, dir } = seed();
  try {
    binding(db);
    const messageId = insertMessage(db);
    enqueueManagedTask(db, task(messageId));
    const stolen = claimNextQueuedRun(db, {
      instanceId: "inst-1",
      ownerToken: randomUUID(),
    });
    assert.equal(stolen, null);
    const state = db
      .prepare(`SELECT state FROM managed_codex_runs WHERE message_id = ?`)
      .get(messageId) as { state: string };
    assert.equal(state.state, "queued", "a foreign token must not touch the queue");
  } finally {
    cleanup(db, dir);
  }
});

test("run state transitions are conditional on the expected previous state", () => {
  const { db, dir } = seed();
  try {
    const owner = binding(db);
    const messageId = insertMessage(db);
    const run = enqueueManagedTask(db, task(messageId));
    // submitting → running is legal straight from queued? No: must be claimed first.
    const skipped = updateManagedRun(
      db,
      run.id,
      owner,
      { state: "running" },
      { fromStates: ["submitting"] },
    );
    assert.equal(skipped, null, "queued must not jump to running without a claim");
    claimNextQueuedRun(db, { instanceId: "inst-1", ownerToken: owner });
    const moved = updateManagedRun(
      db,
      run.id,
      owner,
      { state: "running", threadId: "thread-fixture-1", turnId: "turn-1" },
      { fromStates: ["submitting"] },
    );
    assert.ok(moved);
    assert.equal(moved.state, "running");
    assert.equal(moved.turn_id, "turn-1");
    // terminal states refuse further transitions
    const done = updateManagedRun(
      db,
      run.id,
      owner,
      { state: "completed", finalText: "result text" },
      { fromStates: ["running"] },
    );
    assert.ok(done);
    assert.equal(done.state, "completed");
    assert.equal(done.final_text, "result text");
    // A late failure event must not flip the completed run — even a guard
    // that (wrongly) names the terminal state as its starting point.
    const after = updateManagedRun(
      db,
      run.id,
      owner,
      { state: "failed" },
      { fromStates: ["completed", "running"] },
    );
    assert.equal(after, null, "completed is terminal");
    const stillDone = db
      .prepare(`SELECT state FROM managed_codex_runs WHERE id = ?`)
      .get(run.id) as { state: string };
    assert.equal(stillDone.state, "completed");
  } finally {
    cleanup(db, dir);
  }
});

test("an expired owner cannot complete the new owner's run", () => {
  const { db, dir } = seed();
  try {
    const oldOwner = binding(db);
    const messageId = insertMessage(db);
    const run = enqueueManagedTask(db, task(messageId));
    claimNextQueuedRun(db, { instanceId: "inst-1", ownerToken: oldOwner });
    updateManagedRun(db, run.id, oldOwner, { state: "running" }, { fromStates: ["submitting"] });

    // Recovery hands the binding to a new manager generation.
    const newOwner = replaceManagedBindingOwner(db, "inst-1", {
      sessionId: "managed-1",
      threadId: "thread-fixture-1",
    });

    const staleWrite = updateManagedRun(
      db,
      run.id,
      oldOwner,
      { state: "completed", finalText: "stale manager wrote this" },
      { fromStates: ["running"] },
    );
    assert.equal(staleWrite, null, "the stale generation must not finalize the run");

    const freshWrite = updateManagedRun(
      db,
      run.id,
      newOwner,
      { state: "completed", finalText: "new manager result" },
      { fromStates: ["running"] },
    );
    assert.ok(freshWrite, "the current owner may complete it");
    assert.equal(freshWrite.final_text, "new manager result");
  } finally {
    cleanup(db, dir);
  }
});

test("v14 databases upgrade: presets default to terminal and managed tables appear", () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-upgrade-"));
  const dbPath = join(dir, "data.db");
  try {
    const legacy: DB = openDb({ dataDir: dir, dbPath, scope: "global" });
    legacy.exec(`
      INSERT INTO runtime_agents (name, runtime, workdir, created_at, updated_at)
        VALUES ('legacy codex', 'codex', NULL, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
      INSERT INTO sessions (id, name, status, created_at, last_heartbeat_at)
        VALUES ('old-a', 'a', 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
      INSERT INTO messages (from_session, to_session, question, status, created_at)
        VALUES ('old-a', 'old-a', 'old question', 'replied', '2026-05-02T00:00:00.000Z');
      PRAGMA user_version = 14;
    `);
    stopWalCheckpoint(legacy);
    legacy.close();

    const upgraded: DB = openDb({ dataDir: dir, dbPath, scope: "global" });
    try {
      assert.equal(upgraded.pragma("user_version", { simple: true }), 15);
      // Preset data preserved, with the mode defaulting to terminal.
      const preset = upgraded
        .prepare(`SELECT name, execution_mode FROM runtime_agents`)
        .get() as { name: string; execution_mode: string };
      assert.equal(preset.name, "legacy codex");
      assert.equal(preset.execution_mode, "terminal");
      const messages = upgraded
        .prepare(`SELECT COUNT(*) AS n FROM messages`)
        .get() as { n: number };
      assert.equal(messages.n, 1);
      for (const table of [
        "managed_codex_bindings",
        "managed_codex_runs",
        "managed_codex_events",
        "managed_codex_approvals",
      ]) {
        const cols = upgraded.pragma(`table_info(${table})`) as { name: string }[];
        assert.ok(cols.length > 0, `${table} must exist after upgrade`);
      }
      // message_id uniqueness is enforced by the schema itself
      const cols = upgraded.pragma(`table_info(managed_codex_runs)`) as { name: string }[];
      assert.ok(cols.some((c) => c.name === "submit_text"));
    } finally {
      stopWalCheckpoint(upgraded);
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listing the queue for an instance stays in local submission order", () => {
  const { db, dir } = seed();
  try {
    const owner = binding(db);
    const rows: ManagedRunRow[] = [];
    for (const q of ["first task", "second task", "third task"]) {
      const messageId = insertMessage(db, q);
      rows.push(enqueueManagedTask(db, task(messageId)));
    }
    const first = claimNextQueuedRun(db, { instanceId: "inst-1", ownerToken: owner });
    assert.equal(first?.id, rows[0].id, "oldest queued run is claimed first");
    const second = claimNextQueuedRun(db, { instanceId: "inst-1", ownerToken: owner });
    assert.equal(second?.id, rows[1].id);
  } finally {
    cleanup(db, dir);
  }
});
