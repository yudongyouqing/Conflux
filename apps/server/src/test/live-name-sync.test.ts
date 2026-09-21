import { test, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHookEvent, readRuntimeSessionName } from "../core/live.js";
import { getSession } from "../core/sessions.js";
import { makeDb } from "./helpers.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));

function freshDb() {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

// Same env-pin pattern as live-title.test.ts: the ancestor walk reads this
// before walking, making the claude pid deterministic in this file.
const TEST_CLAUDE_PID = 424242;
process.env.MUILTCHAT_CLAUDE_PID = String(TEST_CLAUDE_PID);

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "muiltchat-name-sync-"));
}

function writeRuntimeName(
  home: string,
  pid: number,
  name: string,
  source: "user" | "derived",
): void {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ name, nameSource: source, nameSince: "1789961421325" }),
    "utf8",
  );
}

function disposeHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // temp dirs are disposable
  }
}

describe("readRuntimeSessionName", () => {
  it("reads name+source from sessions/<pid>.json, null on missing/corrupt", () => {
    const home = fakeHome();
    writeRuntimeName(home, 111, "conflux-66", "derived");
    assert.deepEqual(readRuntimeSessionName(home, 111), {
      name: "conflux-66",
      source: "derived",
    });
    assert.equal(readRuntimeSessionName(home, 222), null, "missing pid file");
    writeFileSync(join(home, "sessions", "333.json"), "{not json", "utf8");
    assert.equal(readRuntimeSessionName(home, 333), null, "corrupt json");
    assert.equal(readRuntimeSessionName(home, null), null, "no pid");
    disposeHome(home);
  });
});

describe("node name matches the terminal tab (directory)", () => {
  it("session-start names the node after the project directory", () => {
    const db = freshDb();
    const home = fakeHome();
    handleHookEvent(
      db,
      "session-start",
      { session_id: "dir-name-1", cwd: "/Users/x/code/Conflux" },
      home,
    );
    assert.equal(getSession(db, "dir-name-1")!.name, "Conflux");
    disposeHome(home);
  });

  it("derived runtime names are NOT used — directory wins (terminal parity)", () => {
    const db = freshDb();
    const home = fakeHome();
    writeRuntimeName(home, TEST_CLAUDE_PID, "conflux-66", "derived");
    handleHookEvent(
      db,
      "session-start",
      { session_id: "dir-name-2", cwd: "/Users/x/code/Conflux" },
      home,
    );
    assert.equal(getSession(db, "dir-name-2")!.name, "Conflux");
    disposeHome(home);
  });

  it("prompt-created node uses the directory name; first prompt kept as description", () => {
    const db = freshDb();
    const home = fakeHome();
    handleHookEvent(
      db,
      "prompt",
      { session_id: "dir-name-3", cwd: "/Users/x/agent-session-search/AgentRecall", prompt: "帮我运行起来这个项目" },
      home,
    );
    const row = getSession(db, "dir-name-3")!;
    assert.equal(row.name, "AgentRecall");
    assert.equal(row.description, "帮我运行起来这个项目");
    disposeHome(home);
  });

  it("two sessions in the same directory get a dedup suffix", () => {
    const db = freshDb();
    const home = fakeHome();
    handleHookEvent(
      db,
      "session-start",
      { session_id: "dup-1", cwd: "/Users/x/code/Conflux" },
      home,
    );
    // second session registers via the prompt path (real-world: hooks were
    // not yet installed when it started) — same env-pinned pid would make a
    // second session-start prune dup-1 as an abandoned conversation
    handleHookEvent(
      db,
      "prompt",
      { session_id: "dup-2", cwd: "/Users/x/code/Conflux", prompt: "第二个同目录会话" },
      home,
    );
    assert.equal(getSession(db, "dup-1")!.name, "Conflux");
    assert.equal(getSession(db, "dup-2")!.name, "Conflux·2");
    disposeHome(home);
  });

  it("user rename (nameSource=user) overrides the directory name and sticks", () => {
    const db = freshDb();
    const home = fakeHome();
    handleHookEvent(
      db,
      "session-start",
      { session_id: "user-name-1", cwd: "/Users/x/code/Conflux" },
      home,
    );
    // user renames in Claude Code → runtime file switches to nameSource=user
    writeRuntimeName(home, TEST_CLAUDE_PID, "我的专用名", "user");
    handleHookEvent(
      db,
      "prompt",
      { session_id: "user-name-1", cwd: "/Users/x/code/Conflux", prompt: "继续干活" },
      home,
    );
    assert.equal(getSession(db, "user-name-1")!.name, "我的专用名");
    // a later prompt must NOT rename it back to the directory
    handleHookEvent(
      db,
      "prompt",
      { session_id: "user-name-1", cwd: "/Users/x/code/Conflux", prompt: "再干一件事" },
      home,
    );
    assert.equal(getSession(db, "user-name-1")!.name, "我的专用名");
    disposeHome(home);
  });

  it("first prompt stays the fallback when cwd is unknown", () => {
    const db = freshDb();
    const home = fakeHome();
    handleHookEvent(
      db,
      "prompt",
      { session_id: "no-cwd-1", prompt: "没有目录信息时的首条消息" },
      home,
    );
    assert.equal(getSession(db, "no-cwd-1")!.name, "没有目录信息时的首条消息");
    disposeHome(home);
  });
});
