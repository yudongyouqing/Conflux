import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  registerSession,
  getSession,
  markStaleSessions,
  listSessions,
  endSession,
  pruneAbandonedSessions,
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

// ---- pruneAbandonedSessions: zero-turn zombie cleanup -----------------------

function ageOut(id: string) {
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 3600_000).toISOString(),
    id
  );
  markStaleSessions(db);
}

test("pruneAbandonedSessions removes stale zero-turn rows, keeps named/referenced/console", () => {
  const mk = (id: string, extra: Record<string, unknown> = {}) =>
    registerSession(db, {
      id,
      name: "muiltchat",
      description: "Claude Code session (hook)",
      metadata: { source: "claude-hook", ...extra },
    });

  mk("zombie-plain"); // opened, /resume'd away, never prompted
  mk("zombie-temp", { temp: true }); // dead MCP placeholder
  mk("real-named", { named: true }); // got at least one prompt
  mk("real-asked"); // never prompted, but someone asked it → has messages
  registerSession(db, {
    id: "web-console",
    name: "Web 控制台",
    description: "浏览器界面身份",
    metadata: null,
  });
  askSession(db, { from_session: "real-named", to_session: "real-asked", question: "hi" });
  for (const id of ["zombie-plain", "zombie-temp", "real-named", "real-asked", "web-console"]) {
    ageOut(id);
  }

  const removed = pruneAbandonedSessions(db);
  assert.ok(removed >= 2);
  assert.equal(getSession(db, "zombie-plain"), null);
  assert.equal(getSession(db, "zombie-temp"), null);
  assert.ok(getSession(db, "real-named"), "named sessions survive");
  assert.ok(getSession(db, "real-asked"), "referenced sessions survive");
  assert.ok(getSession(db, "web-console"), "web-console survives");
});

test("pruneAbandonedSessions keeps active zombies in global mode (stale gate)", () => {
  registerSession(db, {
    id: "fresh-zombie",
    name: "muiltchat",
    description: "Claude Code session (hook)",
    metadata: { source: "claude-hook" },
  });
  assert.equal(pruneAbandonedSessions(db), 0);
  assert.ok(getSession(db, "fresh-zombie"), "active zero-turn row waits for stale TTL");
});

test("pruneAbandonedSessions claudePid mode reaps the /resume-away predecessor instantly", () => {
  registerSession(db, {
    id: "abandoned-id",
    name: "muiltchat",
    description: "Claude Code session (hook)",
    metadata: { source: "claude-hook", claude_pid: 777 },
  });
  registerSession(db, {
    id: "current-id",
    name: "resumed-conversation",
    description: "doing something",
    metadata: { source: "claude-hook", claude_pid: 777 },
  });

  const removed = pruneAbandonedSessions(db, { claudePid: 777, keepId: "current-id" });
  assert.ok(removed >= 1);
  assert.equal(getSession(db, "abandoned-id"), null, "same-pid unnamed predecessor is reaped");
  assert.ok(getSession(db, "current-id"), "the session being registered is kept");
});

