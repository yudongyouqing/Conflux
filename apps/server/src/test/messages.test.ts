import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  askSession,
  getMessage,
  replyAsk,
  checkInbox,
  checkReplies,
  listMessages,
} from "../core/messages.js";
import { recordEdge, getGraph } from "../core/graph.js";
import { registerSession } from "../core/sessions.js";

const { db, cleanup } = makeDb();
after(cleanup);
registerSession(db, { id: "a", name: "a" });
registerSession(db, { id: "b", name: "b" });

test("askSession creates pending message", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "schema?" });
  assert.equal(m.status, "pending");
  assert.equal(m.reply, null);
  assert.equal(getMessage(db, m.id)!.question, "schema?");
});

test("askSession refuses self-ask", () => {
  assert.throws(() => askSession(db, { from_session: "a", to_session: "a", question: "?" }), /cannot ask yourself/);
});

test("replyAsk rejects non-addressee", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "q" });
  assert.throws(() => replyAsk(db, m.id, "a", "nope"), /not the addressee/);
});

test("replyAsk sets replied status and replied_at", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "deploy?" });
  const r = replyAsk(db, m.id, "b", "docker compose");
  assert.equal(r.status, "replied");
  assert.equal(r.reply, "docker compose");
  assert.ok(r.replied_at);
});

test("checkInbox returns pending questions for addressee only", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "inbox?" });
  const inbox = checkInbox(db, "b");
  assert.ok(inbox.some((x) => x.id === m.id));
  assert.equal(checkInbox(db, "a").length, 0);
});

test("checkReplies returns answered then marks read", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "read?" });
  replyAsk(db, m.id, "b", "answer");
  const first = checkReplies(db, "a");
  assert.ok(first.some((x) => x.id === m.id));
  const stillReplied = listMessages(db, { from_session: "a", status: "replied" });
  assert.ok(!stillReplied.some((x) => x.id === m.id), "replied should have been marked read");
});

test("listMessages filters by from/to/status", () => {
  const all = listMessages(db, { status: "all" });
  assert.ok(all.length >= 4);
  const fromA = listMessages(db, { from_session: "a", status: "all" });
  assert.ok(fromA.every((m) => m.from_session === "a"));
  const toB = listMessages(db, { to_session: "b", status: "all" });
  assert.ok(toB.every((m) => m.to_session === "b"));
});

test("ask/reply record directed edges with accumulating weights", () => {
  const before = getGraph(db, { status: "all" }).edges.find((e) => e.from === "a" && e.to === "b")?.weight ?? 0;
  askSession(db, { from_session: "a", to_session: "b", question: "edge1" });
  askSession(db, { from_session: "a", to_session: "b", question: "edge2" });
  const g = getGraph(db, { status: "all" });
  const ab = g.edges.find((e) => e.from === "a" && e.to === "b")!;
  assert.equal(ab.weight, before + 2, "two more asks should add +2 weight");
  const ba = g.edges.find((e) => e.from === "b" && e.to === "a");
  assert.ok(ba, "reply should create reverse edge");
});

test("recordEdge upsert is idempotent-safe increment", () => {
  recordEdge(db, "x", "y");
  recordEdge(db, "x", "y");
  const g = getGraph(db, { status: "all" });
  assert.equal(g.edges.find((e) => e.from === "x" && e.to === "y")!.weight, 2);
});

