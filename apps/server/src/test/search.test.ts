import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { publishContext } from "../core/context.js";
import { queryContext } from "../core/search.js";
import { registerSession } from "../core/sessions.js";

const { db, cleanup } = makeDb();
after(cleanup);
registerSession(db, { id: "a", name: "a" });
registerSession(db, { id: "b", name: "b" });

publishContext(db, { session_id: "a", title: "auth refactor", content: "moving auth to JWT tokens", tags: ["auth"] });
publishContext(db, { session_id: "b", title: "deploy notes", content: "docker compose setup", tags: ["ops"] });
publishContext(db, { session_id: "b", title: "api schema", content: "GET /api/user returns fields", tags: ["api"] });

test("FTS query matches by content keyword", () => {
  const hits = queryContext(db, { query: "docker" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "deploy notes");
});

test("FTS query matches by title keyword", () => {
  const hits = queryContext(db, { query: "auth" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session_id, "a");
});

test("tag filter narrows results", () => {
  const hits = queryContext(db, { tags: ["api"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "api schema");
});

test("session_id filter restricts to one session", () => {
  const hits = queryContext(db, { session_id: "b" });
  assert.ok(hits.length >= 2);
  assert.ok(hits.every((e) => e.session_id === "b"));
});

test("empty query returns recent entries up to limit", () => {
  const hits = queryContext(db, { limit: 2 });
  assert.equal(hits.length, 2);
});

