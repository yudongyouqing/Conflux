import { test, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHookEvent, readRuntimeSessionName } from "../core/live.js";
import { getSession } from "../core/sessions.js";
import { makeDb } from "./helpers.js";

const { db, cleanup } = makeDb();
after(cleanup);

// Same env-pin pattern as live-title.test.ts: the ancestor walk reads this
// before walking, making the claude pid deterministic in this file.
const TEST_CLAUDE_PID = 424242;
process.env.MUILTCHAT_CLAUDE_PID = String(TEST_CLAUDE_PID);

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "muiltchat-name-sync-"));
}

function writeRuntimeName(home: string, pid: number, name: string, source = "derived"): void {
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
  it("reads name from sessions/<pid>.json, null on missing/corrupt", () => {
    const home = fakeHome();
    writeRuntimeName(home, 111, "conflux-66");
    assert.equal(readRuntimeSessionName(home, 111), "conflux-66");
    assert.equal(readRuntimeSessionName(home, 222), null, "missing pid file");
    writeFileSync(join(home, "sessions", "333.json"), "{not json", "utf8");
    assert.equal(readRuntimeSessionName(home, 333), null, "corrupt json");
    assert.equal(readRuntimeSessionName(home, null), null, "no pid");
    disposeHome(home);
  });
});

describe("node name syncs with the runtime session name", () => {
  it("session-start names the node from the runtime name file", () => {
    const home = fakeHome();
    writeRuntimeName(home, TEST_CLAUDE_PID, "conflux-66");
    handleHookEvent(
      db,
      "session-start",
      { session_id: "name-sync-1", cwd: "/tmp/ns1" },
      home,
    );
    assert.equal(getSession(db, "name-sync-1")!.name, "conflux-66");
    disposeHome(home);
  });

  it("prompt-created node uses the runtime name; first prompt kept as description", () => {
    const home = fakeHome();
    writeRuntimeName(home, TEST_CLAUDE_PID, "agentrecall-0a");
    handleHookEvent(
      db,
      "prompt",
      { session_id: "name-sync-2", cwd: "/tmp/ns2", prompt: "帮我运行起来这个项目" },
      home,
    );
    const row = getSession(db, "name-sync-2")!;
    assert.equal(row.name, "agentrecall-0a");
    assert.equal(row.description, "帮我运行起来这个项目");
    disposeHome(home);
  });

  it("rename in the runtime (nameSource=user) propagates on the next prompt", () => {
    const home = fakeHome();
    writeRuntimeName(home, TEST_CLAUDE_PID, "conflux-66");
    handleHookEvent(
      db,
      "session-start",
      { session_id: "name-sync-3", cwd: "/tmp/ns3" },
      home,
    );
    // user renames in Claude Code → the runtime file changes
    writeRuntimeName(home, TEST_CLAUDE_PID, "我的专用名", "user");
    handleHookEvent(
      db,
      "prompt",
      { session_id: "name-sync-3", cwd: "/tmp/ns3", prompt: "继续干活" },
      home,
    );
    assert.equal(getSession(db, "name-sync-3")!.name, "我的专用名");
    disposeHome(home);
  });

  it("missing runtime name file falls back to the first-prompt naming", () => {
    const home = fakeHome();
    handleHookEvent(
      db,
      "prompt",
      { session_id: "name-sync-4", cwd: "/tmp/ns4", prompt: "没有名字文件时的首条消息" },
      home,
    );
    assert.equal(getSession(db, "name-sync-4")!.name, "没有名字文件时的首条消息");
    disposeHome(home);
  });
});
