import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  registerSession,
  getSession,
  markStaleSessions,
  listSessions,
  endSession,
} from "../core/sessions.js";
import { publishContext } from "../core/context.js";
import { askSession } from "../core/messages.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("registerSession upserts: same id updates name and stays active", () => {
  registerSession(db, { id: "s1", name: "first", description: null });
  registerSession(db, { id: "s1", name: "second", description: "d" });
  const s = getSession(db, "s1")!;
  assert.equal(s.name, "second");
  assert.equal(s.status, "active");
});

test("markStaleSessions flips old heartbeats to stale", () => {
  registerSession(db, { id: "old", name: "old" });
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 3600_000).toISOString(),
    "old"
  );
  registerSession(db, { id: "fresh", name: "fresh" });
  const changed = markStaleSessions(db, new Date());
  assert.ok(changed >= 1);
  assert.equal(getSession(db, "old")!.status, "stale");
  assert.equal(getSession(db, "fresh")!.status, "active");
});

test("listSessions carries context_count and pending_inbox", () => {
  registerSession(db, { id: "a", name: "a" });
  registerSession(db, { id: "b", name: "b" });
  publishContext(db, { session_id: "a", title: "t", content: "c", tags: null });
  askSession(db, { from_session: "b", to_session: "a", question: "q" });
  const all = listSessions(db, { status: "all" });
  const a = all.find((s) => s.id === "a")!;
  assert.equal(a.context_count, 1);
  assert.equal(a.pending_inbox, 1);
});

test("endSession marks ended", () => {
  registerSession(db, { id: "bye", name: "bye" });
  endSession(db, "bye");
  assert.equal(getSession(db, "bye")!.status, "ended");
});

