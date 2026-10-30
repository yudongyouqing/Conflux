import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { registerSession, endSession } from "../core/sessions.js";
import { findSessionCandidates } from "../core/session-candidates.js";

test("only an exact full ID resolves without a choice; duplicate names stay distinct", (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);
  registerSession(db, { id: "one-full-id", name: "Backend", project_dir: "/repo" });
  registerSession(db, { id: "two-full-id", name: "Backend", project_dir: "/repo" });
  assert.equal(findSessionCandidates(db, "one-full-id").requires_confirmation, false);
  const result = findSessionCandidates(db, "Backend");
  assert.equal(result.requires_confirmation, true);
  assert.deepEqual(
    new Set(result.candidates.map((s) => s.id)),
    new Set(["one-full-id", "two-full-id"]),
  );
});

test("missing terminal titles offer recent project/runtime candidates without altering messages", (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);
  registerSession(db, {
    id: "peer",
    name: "New terminal name",
    project_dir: "C:\\work\\conflux",
    runtime: "codex",
  });
  registerSession(db, { id: "old", name: "Other", project_dir: "/elsewhere" });
  endSession(db, "old");
  const result = findSessionCandidates(db, "Old Ghostty title", {
    project_dir: "C:/work/conflux",
    runtime: "codex",
  });
  assert.equal(result.requires_confirmation, true);
  assert.equal(result.candidates[0].id, "peer");
  assert.ok(result.candidates[0].reasons.includes("project"));
  assert.ok(result.candidates[0].last_heartbeat_at);
  assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal(findSessionCandidates(db, "no match").requires_confirmation, true);
  assert.ok(findSessionCandidates(db, "no match").candidates.length <= 3);
});
