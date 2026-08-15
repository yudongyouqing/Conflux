import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHookEvent, readCustomTitle, deleteUnreferencedSession } from "../core/live.js";
import { getSession, registerSession } from "../core/sessions.js";
import { makeDb } from "./helpers.js";

const { db, cleanup } = makeDb();
after(cleanup);

// fake ~/.claude with a transcript per test case
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "muiltchat-title-home-"));
}

function writeTranscript(home: string, projectDir: string, sessionId: string, lines: object[]): void {
  const munged = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(home, "projects", munged);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
}

function disposeHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly; temp dirs are disposable.
  }
}

describe("readCustomTitle", () => {
  const SID = "11111111-2222-3333-4444-555555555555";

  it("returns the last custom-title entry", () => {
    const home = fakeHome();
    writeTranscript(home, "C:\\work\\demo app", SID, [
      { type: "user", message: "hello" },
      { type: "custom-title", customTitle: "first name" },
      { type: "assistant", message: "hi" },
      { type: "custom-title", customTitle: "renamed later" },
      { type: "assistant", message: "done" },
    ]);
    assert.equal(readCustomTitle(SID, "C:\\work\\demo app", join(home)), "renamed later");
    disposeHome(home);
  });

  it("returns null when the transcript has no custom-title", () => {
    const home = fakeHome();
    writeTranscript(home, "C:\\work\\plain", SID, [{ type: "user", message: "hello" }]);
    assert.equal(readCustomTitle(SID, "C:\\work\\plain", join(home)), null);
    disposeHome(home);
  });

  it("finds the transcript via project-dir scan when cwd misses", () => {
    const home = fakeHome();
    writeTranscript(home, "C:\\actual\\project", SID, [
      { type: "custom-title", customTitle: "found by scan" },
    ]);
    assert.equal(readCustomTitle(SID, "C:\\somewhere\\else", join(home)), "found by scan");
    disposeHome(home);
  });

  it("picks up an early rename buried under 200KB+ of later transcript", () => {
    const home = fakeHome();
    const filler = { type: "progress", data: "x".repeat(512) };
    const lines: object[] = Array.from({ length: 500 }, () => filler);
    lines.push({ type: "custom-title", customTitle: "tail rename" });
    lines.push({ type: "assistant", message: "after rename" });
    writeTranscript(home, "C:\\work\\big", SID, lines);
    assert.equal(readCustomTitle(SID, "C:\\work\\big", join(home)), "tail rename");
    disposeHome(home);
  });

  it("returns null when the projects dir does not exist", () => {
    const home = fakeHome();
    assert.equal(readCustomTitle(SID, "C:\\work\\none", join(home)), null);
    disposeHome(home);
  });
});

describe("handleHookEvent title sync", () => {
  it("custom-title wins over prompt excerpt", () => {
    const home = fakeHome();
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const cwd = "C:\\work\\titled";
    // prompt names the node first...
    handleHookEvent(db, "prompt", { session_id: sid, cwd, prompt: "很长的第一句话" }, join(home));
    assert.equal(getSession(db, sid)!.name, "很长的第一句话");
    // ...then the user renames: the title must take over on the next event
    writeTranscript(home, cwd, sid, [{ type: "custom-title", customTitle: "my new title" }]);
    handleHookEvent(db, "stop", { session_id: sid, cwd }, join(home));
    assert.equal(getSession(db, sid)!.name, "my new title");
    disposeHome(home);
  });

  it("resume with a title keeps it instead of the cwd basename", () => {
    const home = fakeHome();
    const sid = "ffffffff-1111-2222-3333-444444444444";
    const cwd = "C:\\work\\resume";
    writeTranscript(home, cwd, sid, [{ type: "custom-title", customTitle: "resumed name" }]);
    handleHookEvent(db, "session-start", { session_id: sid, cwd }, join(home));
    assert.equal(getSession(db, sid)!.name, "resumed name");
    disposeHome(home);
  });

  it("prompt excerpt still applies when there is no title", () => {
    const home = fakeHome();
    const sid = "55555555-6666-7777-8888-999999999999";
    handleHookEvent(db, "prompt", { session_id: sid, cwd: "C:\\work\\untitled", prompt: "second line\nmore" }, join(home));
    assert.equal(getSession(db, sid)!.name, "second line");
    disposeHome(home);
  });
});

describe("deleteUnreferencedSession", () => {
  it("never deletes hook-registered sessions, even unreferenced", () => {
    const sid = "c0c0c0c0-1111-2222-3333-444444444444";
    handleHookEvent(db, "prompt", { session_id: sid, cwd: "C:\\work\\keep", prompt: "hook node" });
    assert.equal(deleteUnreferencedSession(db, sid), false);
    assert.ok(getSession(db, sid));
  });

  it("deletes unreferenced temp nodes (MCP auto-register)", () => {
    registerSession(db, { id: "temp-uuid-1", name: "temp" });
    assert.equal(deleteUnreferencedSession(db, "temp-uuid-1"), true);
    assert.equal(getSession(db, "temp-uuid-1"), null);
  });
});
