import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers.js";
import type { DB } from "../core/db.js";
import { registerSession, mergeSessionMeta } from "../core/sessions.js";
import { askSession, getMessage } from "../core/messages.js";
import { parsePaneList } from "../core/wake/tmux-inject.js";
import { tmuxWakeCommand } from "../core/wake/commands.js";
import { wakeSessionForMail } from "../core/wake/index.js";
import type { TmuxIO } from "../core/mail-push.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));
function freshDb(): DB {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

/** Fake claude home with a transcript for the session — makes hasTranscript true. */
function fakeClaudeHome(sessionId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "typed-wake-home-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "projects", "proj-x"), { recursive: true });
  writeFileSync(join(dir, "projects", "proj-x", `${sessionId}.jsonl`), "{}\n");
  return dir;
}

interface Rec {
  aliveNames: string[];
  launches: Array<{ name: string; command: string; cwd?: string | null }>;
  sends: Array<{ target: string; text: string }>;
  captures: number;
}

function fakeIO(rec: Rec): TmuxIO {
  return {
    available: () => true,
    alive: (name) => rec.aliveNames.includes(name),
    paneForPid: () => null,
    send: (target, text) => {
      rec.sends.push({ target, text });
      return true;
    },
    launch: (opts) => {
      rec.launches.push(opts);
      rec.aliveNames.push(opts.name);
      return true;
    },
    capture: () => {
      rec.captures += 1;
      return "claude is ready >";
    },
  };
}

// ---- pure pieces --------------------------------------------------------------

test("parsePaneList matches pane by tty with a foreground-command guard", () => {
  const list = ["%0 /dev/ttys001 zsh", "%3 /dev/ttys004 claude", "%5 /dev/ttys007 vim"].join("\n");
  // tty match + claude is the foreground process → injectable
  assert.equal(parsePaneList(list, "ttys004", "/Users/x/.local/bin/claude"), "%3");
  // ps may report the bare name too
  assert.equal(parsePaneList(list, "ttys004", "claude"), "%3");
  // tty found but foreground is a shell (claude suspended / not running) → refuse
  assert.equal(parsePaneList(list, "ttys001", "claude"), null);
  // tty not in any pane → not a tmux session
  assert.equal(parsePaneList(list, "ttys999", "claude"), null);
  assert.equal(parsePaneList("", "ttys004", "claude"), null);
});

test("tmuxWakeCommand is an INTERACTIVE resume with pre-authorized MCP tools", () => {
  const cmd = tmuxWakeCommand("sess-1", "claude");
  assert.ok(cmd.includes("--resume"), "resumes the real conversation");
  assert.ok(cmd.includes("allowedTools"), "headless pre-auth carried over");
  assert.ok(!cmd.includes(" -p"), "must not be headless -p");
});

// ---- wake branches ------------------------------------------------------------

test("wake: live session with a tmux pane gets the badged full mail typed, not a notice", () => {
  const db = freshDb();
  registerSession(db, { id: "asker", name: "提问方" });
  registerSession(db, { id: "t-1", name: "在线目标" });
  const m = askSession(db, { from_session: "asker", to_session: "t-1", question: "进度如何？" });
  mergeSessionMeta(db, "t-1", { tmux_session: "conflux/t-1" });

  const rec: Rec = { aliveNames: ["conflux/t-1"], launches: [], sends: [], captures: 0 };
  const res = wakeSessionForMail(db, "t-1", { io: fakeIO(rec) });

  assert.equal(res.woke, true);
  assert.equal(rec.launches.length, 0, "live session: no relaunch");
  assert.equal(rec.sends.length, 1);
  assert.ok(rec.sends[0].text.includes("[Conflux·提问 ← 提问方 · msg #1]"));
  assert.ok(rec.sends[0].text.includes("进度如何"));
  assert.equal(getMessage(db, m.id)!.status, "seen");
});

test("wake: offline claude session is relaunched in tmux and fed after boot", () => {
  const db = freshDb();
  registerSession(db, { id: "asker", name: "提问方" });
  registerSession(db, { id: "off-1", name: "离线目标" });
  const m = askSession(db, { from_session: "asker", to_session: "off-1", question: "在吗" });
  db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = 'off-1'`).run();

  const rec: Rec = { aliveNames: [], launches: [], sends: [], captures: 0 };
  const pending: Array<() => void> = [];
  const res = wakeSessionForMail(db, "off-1", {
    io: fakeIO(rec),
    claudeHome: fakeClaudeHome("off-1"),
    schedule: (fn) => pending.push(fn),
  });

  assert.equal(res.woke, true);
  assert.equal(rec.launches.length, 1, "offline → relaunched in tmux");
  assert.equal(rec.launches[0].name, "conflux/off-1");
  assert.ok(rec.launches[0].command.includes("--resume"));
  assert.equal(rec.launches[0].cwd, null, "no project dir registered");
  // metadata stamped so later injections address it directly
  const row = db
    .prepare(`SELECT metadata FROM sessions WHERE id = 'off-1'`)
    .get() as { metadata: string | null };
  const meta = JSON.parse(row.metadata ?? "{}") as { tmux_session?: string };
  assert.equal(meta.tmux_session, "conflux/off-1");

  // boot readiness poll runs on the schedule; once "ready", the mail is typed
  assert.equal(rec.sends.length, 0, "nothing typed before the TUI is ready");
  for (let i = 0; i < 5 && rec.sends.length === 0; i++) {
    const step = pending.shift();
    if (step) step();
  }
  assert.equal(rec.sends.length, 1);
  assert.ok(rec.sends[0].text.includes("[Conflux·提问 ← 提问方 · msg #1]"));
  assert.equal(getMessage(db, m.id)!.status, "seen");
});

test("wake: typed delivery runs BEFORE the dedup window — typing spawns nothing to stack", () => {
  const db = freshDb();
  registerSession(db, { id: "asker", name: "提问方" });
  registerSession(db, { id: "t-2", name: "在线目标" });
  mergeSessionMeta(db, "t-2", { tmux_session: "conflux/t-2" });

  const rec: Rec = { aliveNames: ["conflux/t-2"], launches: [], sends: [], captures: 0 };
  const io = fakeIO(rec);

  askSession(db, { from_session: "asker", to_session: "t-2", question: "第一个问题" });
  assert.equal(wakeSessionForMail(db, "t-2", { io }).woke, true);
  // 5s later, still inside the 90s dedup window
  askSession(db, { from_session: "asker", to_session: "t-2", question: "第二个问题" });
  const second = wakeSessionForMail(db, "t-2", {
    io,
    now: new Date(Date.now() + 5000),
  });
  assert.equal(second.woke, true, "dedup guards process stacking, not typing");
  assert.equal(rec.sends.length, 2, "the second question must ALSO be typed");
  assert.ok(rec.sends[1].text.includes("第二个问题"));
});

test("wake: offline tmux relaunch carries the #105 mcp-config mount", () => {
  const db = freshDb();
  registerSession(db, { id: "asker", name: "提问方" });
  registerSession(db, { id: "off-3", name: "离线目标" });
  askSession(db, { from_session: "asker", to_session: "off-3", question: "在吗" });
  db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = 'off-3'`).run();

  const rec: Rec = { aliveNames: [], launches: [], sends: [], captures: 0 };
  const pending: Array<() => void> = [];
  wakeSessionForMail(db, "off-3", {
    io: fakeIO(rec),
    claudeHome: fakeClaudeHome("off-3"),
    mcpConfigPath: "/tmp/wake-mcp-test.json",
    schedule: (fn) => pending.push(fn),
  });
  assert.equal(rec.launches.length, 1);
  assert.ok(
    rec.launches[0].command.includes("--mcp-config"),
    "a project that never mounted Conflux must still get the tools (#105)",
  );
});

test("wake: TUI never becomes ready → mail stays pending for the hook fallback", () => {
  const db = freshDb();
  registerSession(db, { id: "asker", name: "提问方" });
  registerSession(db, { id: "off-2", name: "离线目标" });
  const m = askSession(db, { from_session: "asker", to_session: "off-2", question: "在吗" });
  db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = 'off-2'`).run();

  const rec: Rec = { aliveNames: [], launches: [], sends: [], captures: 0 };
  const io: TmuxIO = {
    ...fakeIO(rec),
    capture: () => "", // TUI never paints
  };
  const pending: Array<() => void> = [];
  wakeSessionForMail(db, "off-2", {
    io,
    claudeHome: fakeClaudeHome("off-2"),
    schedule: (fn) => pending.push(fn),
  });

  let guard = 0;
  while (pending.length > 0 && guard++ < 100) (pending.shift() as () => void)();
  assert.deepEqual(rec.sends, [], "no typing into a TUI that never booted");
  assert.equal(getMessage(db, m.id)!.status, "pending", "hook path still owns delivery");
});
