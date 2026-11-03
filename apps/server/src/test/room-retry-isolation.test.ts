import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { openDb, retryOnBusy, stopWalCheckpoint } from "../core/db.js";
import { prepareSummon, completeSummon, prepareBroadcast } from "../core/room-orchestrator.js";
import { createChatRoom } from "../core/chat-rooms.js";
import { registerSession } from "../core/sessions.js";

// Fault-injection regression for the room operations: summon and broadcast
// previously ran their EXTERNAL delivery (terminal injection, headless wake
// spawn, per-member typed pushes) INSIDE the retried write transaction —
// the same rollback-erases-the-record-then-redoes-the-side-effect hazard
// as the ask path. The split pinned here: the database phase (task row /
// question inserts + claims) may retry N times under contention; the
// external phase runs exactly once, strictly after the commit — the routes
// never wrap complete* in the retry.

test("room summon and broadcast database phases are pure and retry-safe under contention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "room-retry-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  db.pragma("busy_timeout = 50");
  const blocker = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  try {
    registerSession(db, { id: "human", name: "human" });
    registerSession(db, { id: "agent-a", name: "agent a" });
    const room = createChatRoom(db, {
      name: "ops",
      members: ["agent-a"],
    });

    // Contend the lock, then release: the summon database phase retries.
    await blocker.exec("BEGIN IMMEDIATE");
    blocker
      .prepare(
        `INSERT INTO context_entries (session_id, title, content, created_at, updated_at)
         VALUES ('human', 'hold', 'hold', datetime('now'), datetime('now'))`,
      )
      .run();
    let attempts = 0;
    const release = new Promise<void>((resolveRelease) => {
      setTimeout(() => {
        blocker.exec("ROLLBACK");
        resolveRelease();
      }, 700);
    });
    const task = await retryOnBusy(
      db,
      () => {
        attempts++;
        return prepareSummon(db, {
          room_id: room.id,
          initiator_session_id: "human",
          executor_session_id: "agent-a",
          prompt: "do the thing",
        });
      },
      { budgetMs: 4000, pauseMs: 60 },
    );
    await release;
    assert.ok(attempts >= 2, `expected the transaction to be retried, ran ${attempts} time(s)`);
    const tasks = db
      .prepare(`SELECT COUNT(*) AS n FROM room_tasks WHERE prompt = 'do the thing'`)
      .get() as { n: number };
    assert.equal(tasks.n, 1, "each retry must roll back cleanly — exactly one task row");

    // The task is pending (undelivered): the external delivery phase has
    // NOT run as part of prepare — that is the routes' post-commit step.
    const row = db
      .prepare(`SELECT status FROM room_tasks WHERE id = ?`)
      .get(task.id) as { status: string };
    assert.equal(row.status, "pending");

    // Broadcast: same contract. prepareBroadcast inserts questions and
    // claims only; per-member wakes are the post-commit phase.
    const broadcast = await retryOnBusy(
      db,
      () =>
        prepareBroadcast(db, {
          room_id: room.id,
          sender_session_id: "human",
          prompt: "anyone alive",
        }),
      { budgetMs: 2000, pauseMs: 30 },
    );
    assert.ok(broadcast.prepared.length >= 1, "member question prepared");
    const questions = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE question LIKE '%anyone alive%'`)
      .get() as { n: number };
    assert.equal(questions.n, broadcast.prepared.length, "exactly the prepared questions exist");
    for (const prepared of broadcast.prepared) {
      // claim present = wake NOT yet run (completeAsk clears it)
      const claim = db
        .prepare(`SELECT claim_token FROM message_deliveries WHERE message_id = ?`)
        .get(prepared.message.id) as { claim_token: string | null };
      assert.ok(claim.claim_token, "delivery claim held — external phase not yet run");
    }
    void completeSummon; // post-commit delivery entry point, by design outside any retry
  } finally {
    stopWalCheckpoint(blocker);
    blocker.close();
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
