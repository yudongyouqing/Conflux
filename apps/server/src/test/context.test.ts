import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  publishContext,
  getContext,
  updateContext,
  deleteContext,
  listMyContext,
} from "../core/context.js";
import { registerSession } from "../core/sessions.js";

const { db, cleanup } = makeDb();
after(cleanup);
registerSession(db, { id: "owner", name: "owner" });
registerSession(db, { id: "intruder", name: "intruder" });

test("publishContext stores entry with parsed tags", () => {
  const e = publishContext(db, {
    session_id: "owner",
    title: "auth plan",
    content: "moving to JWT",
    tags: ["auth", "jwt"],
  });
  assert.ok(e.id > 0);
  assert.ok(Array.isArray(e.tags) && e.tags.includes("auth"));
  const got = getContext(db, e.id)!;
  assert.equal(got.title, "auth plan");
  assert.equal(got.session_id, "owner");
});

test("updateContext rejects non-owner", () => {
  const e = publishContext(db, { session_id: "owner", title: "t", content: "c", tags: null });
  assert.throws(() => updateContext(db, e.id, "intruder", { title: "hacked" }), /not owner/);
});

test("updateContext applies partial fields for owner", () => {
  const e = publishContext(db, { session_id: "owner", title: "old", content: "c", tags: null });
  const u = updateContext(db, e.id, "owner", { title: "new" })!;
  assert.equal(u.title, "new");
  assert.equal(u.content, "c");
  assert.equal(updateContext(db, 9999, "owner", { title: "x" }), null);
});

test("deleteContext enforces ownership and deletes for owner", () => {
  const e = publishContext(db, { session_id: "owner", title: "t", content: "c", tags: null });
  let threw = false;
  let ok = true;
  try {
    ok = deleteContext(db, e.id, "intruder");
  } catch {
    threw = true;
  }
  assert.ok(threw || ok === false, "non-owner delete must throw or return false");
  assert.ok(getContext(db, e.id), "entry survives non-owner delete attempt");
  assert.equal(deleteContext(db, e.id, "owner"), true);
  assert.equal(getContext(db, e.id), null);
});

test("listMyContext returns only own entries", () => {
  publishContext(db, { session_id: "owner", title: "mine", content: "c", tags: null });
  publishContext(db, { session_id: "intruder", title: "theirs", content: "c", tags: null });
  const mine = listMyContext(db, "owner");
  assert.ok(mine.every((e) => e.session_id === "owner"));
  assert.ok(mine.some((e) => e.title === "mine"));
});

