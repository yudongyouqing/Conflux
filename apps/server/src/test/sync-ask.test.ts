import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import type { DB } from "../core/db.js";
import { askAndReplySync } from "../core/ask-sync.js";
import { registerSession } from "../core/sessions.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));
function freshDb(): DB {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

function setup(db: DB) {
  registerSession(db, { id: "asker", name: "提问方" });
  registerSession(db, { id: "peer", name: "接收方" });
}

test("askAndReplySync returns the reply within timeout (wake succeeds late)", async () => {
  const db = freshDb();
  setup(db);
  let elapsed = 0;
  let replied = false;
  // simulate the woken peer: replies ~120ms of simulated time after the ask
  const sleep = (ms: number) => {
    elapsed += ms;
    if (elapsed >= 120 && !replied) {
      replied = true;
      const row = db
        .prepare("SELECT id FROM messages WHERE from_session='asker' ORDER BY id DESC LIMIT 1")
        .get() as { id: number };
      db.prepare("UPDATE messages SET reply=?, status='replied', replied_at=? WHERE id=?").run(
        "同步回：链路 OK",
        new Date().toISOString(),
        row.id,
      );
    }
    return Promise.resolve();
  };
  const result = await askAndReplySync(db, {
    from_session: "asker",
    to_session: "peer",
    question: "同步问一句",
    timeoutMs: 5_000,
    pollMs: 50,
    sleep,
  });
  assert.equal(result.status, "replied");
  assert.equal(result.reply, "同步回：链路 OK");
});

test("askAndReplySync times out gracefully — message still delivered", async () => {
  const db = freshDb();
  setup(db);
  const result = await askAndReplySync(db, {
    from_session: "asker",
    to_session: "peer",
    question: "没人回的同步问句",
    timeoutMs: 150,
    pollMs: 50,
    sleep: (ms: number) => Promise.resolve(),
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.reply, null);
  const row = db
    .prepare("SELECT status FROM messages WHERE from_session='asker' AND to_session='peer'")
    .get() as { status: string };
  assert.equal(row.status, "pending", "超时后消息仍在投递队列");
});
