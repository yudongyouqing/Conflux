import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import type { DB } from "../core/db.js";
import { registerSession, mergeSessionMeta } from "../core/sessions.js";
import {
  askSession,
  replyAsk,
  getMessage,
  gatherUnseenMail,
  markMailDelivered,
  formatTypedMailPrompt,
} from "../core/messages.js";
import { pushMailTyped, replyAskAndPush, type TmuxIO } from "../core/mail-push.js";
import { setSetting } from "../core/app-settings.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));
function freshDb(): DB {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

interface Recorded {
  alive: string[];
  panes: number[];
  sends: Array<{ target: string; text: string }>;
  launches: Array<{ name: string; command: string; cwd?: string | null }>;
}

/** Fake tmux IO recording every probe; behavior steered by the overrides. */
function fakeIO(over: {
  aliveNames?: string[];
  pane?: string | null;
  sendOk?: boolean;
  available?: boolean;
} = {}): { io: TmuxIO; rec: Recorded } {
  const rec: Recorded = { alive: [], panes: [], sends: [], launches: [] };
  return {
    rec,
    io: {
      available: () => over.available ?? true,
      alive: (name) => {
        rec.alive.push(name);
        return (over.aliveNames ?? []).includes(name);
      },
      paneForPid: (pid) => {
        rec.panes.push(pid);
        return over.pane ?? null;
      },
      send: (target, text) => {
        rec.sends.push({ target, text });
        return over.sendOk ?? true;
      },
      launch: (opts) => {
        rec.launches.push(opts);
        return true;
      },
      capture: () => "ready",
    },
  };
}

function seedChannel(db: DB) {
  registerSession(db, { id: "asker", name: "提问方" });
  registerSession(db, { id: "target", name: "目标会话" });
}

// ---- gather / render / mark ---------------------------------------------------

test("gatherUnseenMail returns the reply for the asker, flattened body included", () => {
  const db = freshDb();
  seedChannel(db);
  const m = askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  replyAsk(db, m.id, "target", "v1.2.3\n详见 changelog");

  const items = gatherUnseenMail(db, "asker");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "reply");
  assert.equal(items[0].from, "目标会话");
  assert.equal(items[0].body, "v1.2.3 详见 changelog");
});

test("formatTypedMailPrompt renders single-line badged prompt, null when empty", () => {
  const db = freshDb();
  seedChannel(db);
  const m = askSession(db, { from_session: "asker", to_session: "target", question: "版本号？" });
  replyAsk(db, m.id, "target", "v1.2.3");

  const items = gatherUnseenMail(db, "asker");
  const prompt = formatTypedMailPrompt(items)!;
  assert.ok(prompt.startsWith("[Conflux·回复 ← 目标会话 · msg #1]"));
  assert.ok(prompt.includes("v1.2.3"));
  assert.ok(!prompt.includes("\n"), "typed text must be a single line (send-keys hazard)");

  // an UNANSWERED question is what the target side receives — an answered
  // one is 'replied' and never re-enters the undelivered flow
  const q2 = askSession(db, { from_session: "asker", to_session: "target", question: "还在吗" });
  const qPrompt = formatTypedMailPrompt(gatherUnseenMail(db, "target"))!;
  assert.ok(qPrompt.startsWith(`[Conflux·提问 ← 提问方 · msg #${q2.id}]`));
  assert.ok(qPrompt.includes("reply_ask"));

  assert.equal(formatTypedMailPrompt([]), null);
});

test("markMailDelivered stops the repeat — question goes seen, reply gets reply_seen_at", () => {
  const db = freshDb();
  seedChannel(db);

  // reply side: ask → answer → mark → gone, with a receipt recorded
  const m = askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  replyAsk(db, m.id, "target", "好的");
  markMailDelivered(db, "asker", gatherUnseenMail(db, "asker"));
  assert.equal(gatherUnseenMail(db, "asker").length, 0, "reply consumed once");
  assert.ok(getMessage(db, m.id)!.reply_seen_at, "reply receipt recorded");

  // question side: pending → seen once delivered (a REPLIED question never
  // re-enters the pending flow — it is already answered)
  const q = askSession(db, { from_session: "asker", to_session: "target", question: "第二条" });
  assert.equal(getMessage(db, q.id)!.status, "pending");
  markMailDelivered(db, "target", gatherUnseenMail(db, "target"));
  assert.equal(getMessage(db, q.id)!.status, "seen");
  assert.equal(gatherUnseenMail(db, "target").length, 0, "question consumed once");
});

// ---- pushMailTyped decision tree ----------------------------------------------

test("pushMailTyped: stamped tmux name alive → badged full mail typed, marked seen", () => {
  const db = freshDb();
  seedChannel(db);
  askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "target", { tmux_session: "conflux/target", claude_pid: 111 });

  const { io, rec } = fakeIO({ aliveNames: ["conflux/target"] });
  const res = pushMailTyped(db, "target", io);
  assert.equal(res.pushed, true);
  assert.equal(res.via, "stamped-tmux");
  assert.equal(rec.sends.length, 1);
  assert.equal(rec.sends[0].target, "conflux/target");
  assert.ok(rec.sends[0].text.includes("[Conflux·提问 ← 提问方 · msg #1]"));
  assert.ok(rec.sends[0].text.includes("在吗"));

  // delivered → nothing left; a second push must not re-send
  assert.equal(pushMailTyped(db, "target", io).pushed, false);
  assert.equal(rec.sends.length, 1);
});

test("pushMailTyped: runtime agent resolves the conflux/agent-<id> convention (no double prefix)", () => {
  const db = freshDb();
  seedChannel(db);
  askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "target", { agent_id: 3 });

  const { io, rec } = fakeIO({ aliveNames: ["conflux/agent-3"] });
  const res = pushMailTyped(db, "target", io);
  assert.equal(res.pushed, true);
  assert.equal(res.via, "agent-tmux");
  assert.equal(rec.sends[0].target, "conflux/agent-3");
});

test("pushMailTyped: pane path resolves claude_pid → pane target", () => {
  const db = freshDb();
  seedChannel(db);
  askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "target", { claude_pid: 4242 });

  const { io, rec } = fakeIO({ pane: "%9" });
  const res = pushMailTyped(db, "target", io);
  assert.equal(res.pushed, true);
  assert.equal(res.via, "pane");
  assert.deepEqual(rec.panes, [4242]);
  assert.equal(rec.sends[0].target, "%9");
});

test("pushMailTyped: busy session never gets pane injection (user may be typing)", () => {
  const db = freshDb();
  seedChannel(db);
  askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "target", { claude_pid: 4242, busy: true });

  const { io, rec } = fakeIO({ pane: "%9" });
  const res = pushMailTyped(db, "target", io);
  assert.equal(res.pushed, false);
  assert.deepEqual(rec.panes, [], "busy → pane probe must not even run");
  assert.deepEqual(rec.sends, []);
});

test("pushMailTyped: busy STAMPED session skips typing — mid-turn TUI may sit on a permission dialog", () => {
  const db = freshDb();
  seedChannel(db);
  askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "target", { tmux_session: "conflux/target", busy: true });

  const { io, rec } = fakeIO({ aliveNames: ["conflux/target"] });
  assert.equal(pushMailTyped(db, "target", io).pushed, false);
  assert.deepEqual(rec.sends, [], "busy user session: typed text could answer a y/n dialog");
});

test("pushMailTyped: busy runtime agent still gets typed mail (queue injection is its lifeline)", () => {
  const db = freshDb();
  seedChannel(db);
  askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "target", { agent_id: 5, busy: true });

  const { io, rec } = fakeIO({ aliveNames: ["conflux/agent-5"] });
  assert.equal(pushMailTyped(db, "target", io).pushed, true);
  assert.equal(rec.sends.length, 1);
});

test("pushMailTyped: send failure leaves mail pending — hook fallback still surfaces it", () => {
  const db = freshDb();
  seedChannel(db);
  const m = askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "target", { tmux_session: "conflux/target" });

  const { io } = fakeIO({ aliveNames: ["conflux/target"], sendOk: false });
  assert.equal(pushMailTyped(db, "target", io).pushed, false);
  assert.equal(getMessage(db, m.id)!.status, "pending", "not marked without successful delivery");
});

test("pushMailTyped: codex works in Conflux-managed tmux, but never via the pane path", () => {
  const db = freshDb();
  seedChannel(db);
  askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  db.prepare(`UPDATE sessions SET runtime = 'codex' WHERE id = 'target'`).run();
  mergeSessionMeta(db, "target", { tmux_session: "conflux/target", claude_pid: 4242 });

  // Conflux-managed tmux target: typing lands in whatever TUI owns the pane
  // (#128 parity — codex runtime agents keep live injection)
  const managed = fakeIO({ aliveNames: ["conflux/target"] });
  assert.equal(pushMailTyped(db, "target", managed.io).pushed, true);

  // the user's own terminal (pane path) is claude-only in v1: claude_pid is
  // never recorded for codex sessions, and a stale one must not be trusted
  db.prepare(`DELETE FROM messages`).run();
  askSession(db, { from_session: "asker", to_session: "target", question: "还在吗" });
  const own = fakeIO({ pane: "%9" });
  const res = pushMailTyped(db, "target", own.io);
  assert.equal(res.pushed, false);
  assert.deepEqual(own.rec.panes, [], "pane probe must not run for codex runtime");
});

test("replyAskAndPush: the asker's pane receives the badged reply", () => {
  const db = freshDb();
  seedChannel(db);
  const m = askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "asker", { claude_pid: 777 });

  const { io, rec } = fakeIO({ pane: "%4" });
  const msg = replyAskAndPush(db, m.id, "target", "收到，处理中", io);
  assert.equal(msg.status, "replied");
  assert.equal(rec.sends.length, 1);
  assert.equal(rec.sends[0].target, "%4");
  assert.ok(rec.sends[0].text.includes("[Conflux·回复 ← 目标会话 · msg #1]"));
  assert.ok(rec.sends[0].text.includes("收到，处理中"));
});

test("replyAskAndPush: auto_wake off means NO typed steering — the setting is consent", () => {
  const db = freshDb();
  seedChannel(db);
  const m = askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  mergeSessionMeta(db, "asker", { claude_pid: 777 });
  setSetting(db, "auto_wake", "false");

  const { io, rec } = fakeIO({ pane: "%4" });
  const msg = replyAskAndPush(db, m.id, "target", "收到", io);
  assert.equal(msg.status, "replied", "the reply itself still lands");
  assert.deepEqual(rec.sends, [], "no typing into terminals when auto_wake is off");
  assert.equal(gatherUnseenMail(db, "asker").length, 1, "hook notice still owns delivery");
});

test("markMailDelivered never regresses a question that got answered mid-delivery", () => {
  const db = freshDb();
  seedChannel(db);
  const m = askSession(db, { from_session: "asker", to_session: "target", question: "在吗" });
  // gathered while pending…
  const items = gatherUnseenMail(db, "target");
  // …then answered before the (tmux-spawning) delivery finished
  replyAsk(db, m.id, "target", "好了");
  markMailDelivered(db, "target", items);
  assert.equal(
    getMessage(db, m.id)!.status,
    "replied",
    "a replied question must not be stamped back to seen",
  );
});
