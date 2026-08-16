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
  listPeerMessages,
  forwardInboxFromPid,
  formatInboxNotice,
} from "../core/messages.js";
import { recordEdge, getGraph } from "../core/graph.js";
import { registerSession } from "../core/sessions.js";

const { db, cleanup } = makeDb();
after(cleanup);
registerSession(db, { id: "a", name: "a" });
registerSession(db, { id: "b", name: "b" });
registerSession(db, { id: "peer-x", name: "x" });
registerSession(db, { id: "peer-y", name: "y" });

test("listPeerMessages returns both directions, oldest first", () => {
  askSession(db, { from_session: "peer-x", to_session: "peer-y", question: "out 1" });
  askSession(db, { from_session: "peer-y", to_session: "peer-x", question: "in 1" });
  askSession(db, { from_session: "peer-x", to_session: "peer-y", question: "out 2" });

  // only the peer pair's flow comes back (a↔b traffic from other tests is excluded)
  const flow = listPeerMessages(db, "peer-x", "peer-y");
  assert.deepEqual(
    flow.map((m) => m.question),
    ["out 1", "in 1", "out 2"]
  );
});

test("askSession creates pending message", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "schema?" });
  assert.equal(m.status, "pending");
  assert.equal(m.reply, null);
  assert.equal(getMessage(db, m.id)!.question, "schema?");
});

test("askSession refuses self-ask", () => {
  assert.throws(() => askSession(db, { from_session: "a", to_session: "a", question: "?" }), /cannot ask yourself/);
});

test("askSession rejects a pruned target with a clear error, not a FK violation", () => {
  assert.throws(
    () => askSession(db, { from_session: "a", to_session: "ghost", question: "?" }),
    /target session not found/
  );
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

test("checkInbox marks messages seen; they stay until replied", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "seen?" });
  assert.equal(getMessage(db, m.id)!.status, "pending");
  const first = checkInbox(db, "b");
  const fetched = first.find((x) => x.id === m.id)!;
  assert.equal(fetched.status, "seen", "fetched copy reports seen");
  assert.equal(getMessage(db, m.id)!.status, "seen", "row updated to seen");
  // unanswered items keep appearing on subsequent checks
  const second = checkInbox(db, "b");
  assert.ok(second.some((x) => x.id === m.id));
  // replying transitions seen -> replied
  const r = replyAsk(db, m.id, "b", "answered");
  assert.equal(r.status, "replied");
});

test("pending_inbox counts seen-but-unanswered messages", () => {
  const before = getGraph(db, { status: "all" }).nodes.find((n) => n.id === "b")!.pending_inbox;
  const m = askSession(db, { from_session: "a", to_session: "b", question: "count-seen?" });
  assert.equal(
    getGraph(db, { status: "all" }).nodes.find((n) => n.id === "b")!.pending_inbox,
    before + 1
  );
  checkInbox(db, "b"); // pending -> seen, still unanswered
  assert.equal(
    getGraph(db, { status: "all" }).nodes.find((n) => n.id === "b")!.pending_inbox,
    before + 1,
    "seen should still count as pending_inbox"
  );
  replyAsk(db, m.id, "b", "done");
  assert.equal(
    getGraph(db, { status: "all" }).nodes.find((n) => n.id === "b")!.pending_inbox,
    before,
    "replied no longer counts"
  );
});

test("listMessages can filter by seen status", () => {
  const m = askSession(db, { from_session: "a", to_session: "b", question: "filter-seen?" });
  checkInbox(db, "b");
  const seenList = listMessages(db, { status: "seen" });
  assert.ok(seenList.some((x) => x.id === m.id));
  const pendingList = listMessages(db, { status: "pending" });
  assert.ok(!pendingList.some((x) => x.id === m.id));
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


// ---- inbox delivery across /resume + proactive notices ----------------------

test("forwardInboxFromPid re-addresses undelivered mail to the resume successor", () => {
  registerSession(db, { id: "old-conv", name: "old", metadata: { source: "claude-hook", claude_pid: 909 } });
  registerSession(db, { id: "other-pid", name: "other", metadata: { source: "claude-hook", claude_pid: 111 } });
  askSession(db, { from_session: "a", to_session: "old-conv", question: "resume 前的提问" });
  askSession(db, { from_session: "a", to_session: "other-pid", question: "别动我" });
  // one already-replied message must stay on the old id (history)
  const replied = askSession(db, { from_session: "a", to_session: "old-conv", question: "已回复的" });
  replyAsk(db, replied.id, "old-conv", "done");

  // the successor row must exist first (messages.to_session has an FK to it)
  registerSession(db, { id: "new-conv", name: "new" });
  const moved = forwardInboxFromPid(db, 909, "new-conv");
  assert.equal(moved, 1, "only the undelivered ask moves");
  const inbox = checkInbox(db, "new-conv");
  assert.ok(inbox.some((m) => m.question === "resume 前的提问"), "mail follows the conversation");
  assert.equal(
    listMessages(db, { to_session: "other-pid", status: "all" }).length,
    1,
    "other pid's mail untouched"
  );
  assert.ok(
    listMessages(db, { to_session: "old-conv", status: "all" }).every((m) => m.status === "replied" || m.status === "read"),
    "replied history stays on the old id"
  );
});

test("formatInboxNotice is silent when read, nagging when pending", () => {
  registerSession(db, { id: "notice-target", name: "nt" });
  assert.equal(formatInboxNotice(db, "notice-target"), null, "empty inbox → no stdout noise");

  askSession(db, { from_session: "a", to_session: "notice-target", question: "你好,\n   多行问题 内容" });
  const notice = formatInboxNotice(db, "notice-target");
  assert.ok(notice && notice.includes("1 条未读"), "mentions the count");
  assert.ok(notice!.includes("多行问题"), "excerpt collapses whitespace");
  assert.ok(notice!.includes("check_inbox"), "tells the model what to call");

  // once the session has actually LOOKED (checkInbox → seen), the nag stops
  checkInbox(db, "notice-target");
  assert.equal(formatInboxNotice(db, "notice-target"), null, "seen mail stops nagging");
});
