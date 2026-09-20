import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers.js";
import {
  parseTranscriptCandidate,
  scanRecentTranscripts,
  backfillLiveClaudeSessions,
  type BackfillCandidate,
  type BackfillIo,
} from "../core/hooks-backfill.js";
import { registerSession } from "../core/sessions.js";
import { getSetting } from "../core/app-settings.js";
import { HOOK_SESSION_DESCRIPTION } from "@conflux/shared";

const { db, cleanup } = makeDb();
after(cleanup);

const T0 = Date.parse("2026-09-20T01:00:00.000Z");

function line(j: unknown): string {
  return JSON.stringify(j) + "\n";
}

test("parseTranscriptCandidate extracts cwd, first prompt, last activity, session id", () => {
  const text =
    line({ type: "user", cwd: "/Users/x/proj", timestamp: "2026-09-20T00:00:01.000Z",
           message: { content: [{ type: "text", text: "帮我运行起来这个项目" }] } }) +
    line({ type: "assistant", timestamp: "2026-09-20T00:00:05.000Z" }) +
    "not-json-garbage\n" +
    line({ type: "user", timestamp: "2026-09-20T00:30:00.000Z",
           message: { content: "<command-name>/rename</command-name>" } });
  const c = parseTranscriptCandidate(text, "/fake/projects/-p/abc123.jsonl");
  assert.equal(c.sessionId, "abc123");
  assert.equal(c.projectDir, "/Users/x/proj");
  assert.equal(c.firstPrompt, "帮我运行起来这个项目");
  assert.equal(c.lastActivityMs, Date.parse("2026-09-20T00:30:00.000Z"));
});

test("parseTranscriptCandidate tolerates missing fields", () => {
  const c = parseTranscriptCandidate("garbage\n", "/x/deadbeef.jsonl");
  assert.equal(c.sessionId, "deadbeef");
  assert.equal(c.projectDir, null);
  assert.equal(c.firstPrompt, null);
  assert.equal(c.lastActivityMs, null);
});

test("scanRecentTranscripts reads per-dir latest N within window, skips old files", () => {
  const home = mkdtempSync(join(tmpdir(), "backfill-home-"));
  const old = join(home, "projects", "-old-", "old1.jsonl");
  const freshA = join(home, "projects", "-old-", "a.jsonl");
  const freshB = join(home, "projects", "-other-", "b.jsonl");
  mkdirSync(join(home, "projects", "-old-"), { recursive: true });
  mkdirSync(join(home, "projects", "-other-"), { recursive: true });
  const body = line({ type: "user", cwd: "/old", timestamp: "2026-09-20T00:00:00.000Z",
                      message: { content: "hello" } });
  for (const p of [old, freshA, freshB]) writeFileSync(p, body, "utf8");
  const past = new Date(T0 - 40 * 24 * 60 * 60 * 1000); // 40 天前 → 窗口外
  utimesSync(old, past, past);
  const found = scanRecentTranscripts(home);
  const ids = found.map((c) => c.sessionId).sort();
  assert.deepEqual(ids, ["a", "b"]);
  rmSync(home, { recursive: true, force: true });
});

// ---- backfillLiveClaudeSessions ---------------------------------------------

const START = T0 - 60 * 60 * 1000;  // 进程 1h 前启动
const ACTIVE = T0 - 10 * 60 * 1000; // 转录 10min 前活跃

function candidate(partial: Partial<BackfillCandidate>): BackfillCandidate {
  return {
    sessionId: "sess-1",
    transcriptPath: "/fake/sess-1.jsonl",
    projectDir: "/Users/x/proj",
    lastActivityMs: ACTIVE,
    firstPrompt: "帮我运行起来这个项目",
    ...partial,
  };
}

function io(
  pids: number[],
  proc: Record<number, { cwd: string; startedAtMs: number } | null>,
  transcripts: BackfillCandidate[],
): BackfillIo {
  return {
    livePids: new Set(pids),
    procInfo: async (pid) => {
      const p = proc[pid];
      return p ? { pid, cwd: p.cwd, startedAtMs: p.startedAtMs } : null;
    },
    recentTranscripts: async () => transcripts,
  };
}

test("registers a live session from a matching transcript", async () => {
  const r = await backfillLiveClaudeSessions(
    db,
    io([100], { 100: { cwd: "/Users/x/proj", startedAtMs: START } }, [candidate({})]),
  );
  assert.equal(r.registered.length, 1);
  assert.deepEqual(r.registered[0], { id: "sess-1", pid: 100, name: "帮我运行起来这个项目" });
  const row = db.prepare("SELECT * FROM sessions WHERE id='sess-1'").get() as {
    project_dir: string;
    description: string;
    metadata: string;
  };
  assert.equal(row.project_dir, "/Users/x/proj");
  const meta = JSON.parse(row.metadata);
  assert.equal(meta.claude_pid, 100);
  assert.equal(meta.source, "claude-hook");
  assert.equal(row.description, HOOK_SESSION_DESCRIPTION);
  assert.equal(getSetting(db, "claude-current:100"), "sess-1");
});

test("second run is idempotent: pid already bound → skip, no duplicate row", async () => {
  const r = await backfillLiveClaudeSessions(
    db,
    io([100], { 100: { cwd: "/Users/x/proj", startedAtMs: START } }, [candidate({})]),
  );
  assert.equal(r.registered.length, 0);
  assert.equal(r.skippedBound, 1);
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id='sess-1'").get() as { n: number }
  ).n;
  assert.equal(n, 1);
});

test("existing pid-less row gets its pid merged, name untouched", async () => {
  registerSession(db, {
    id: "sess-2",
    name: "手动起的名字",
    metadata: { source: "claude-hook", named: true },
  });
  const r = await backfillLiveClaudeSessions(
    db,
    io(
      [200],
      { 200: { cwd: "/Users/x/proj", startedAtMs: START } },
      [candidate({ sessionId: "sess-2" })],
    ),
  );
  assert.equal(r.registered.length, 0);
  assert.equal(r.refreshed, 1);
  const row = db.prepare("SELECT * FROM sessions WHERE id='sess-2'").get() as {
    name: string;
    metadata: string;
  };
  assert.equal(row.name, "手动起的名字");
  assert.equal(JSON.parse(row.metadata).claude_pid, 200);
  assert.equal(getSetting(db, "claude-current:200"), "sess-2");
});

test("transcript older than process start → no match", async () => {
  const r = await backfillLiveClaudeSessions(
    db,
    io(
      [300],
      { 300: { cwd: "/Users/x/proj", startedAtMs: START } },
      [candidate({ sessionId: "sess-3", lastActivityMs: START - 1000 })],
    ),
  );
  assert.equal(r.registered.length, 0);
  assert.equal(r.unmatchedPids, 1);
});

test("cwd mismatch → no match", async () => {
  const r = await backfillLiveClaudeSessions(
    db,
    io(
      [301],
      { 301: { cwd: "/Users/x/other", startedAtMs: START } },
      [candidate({ sessionId: "s4" })],
    ),
  );
  assert.equal(r.unmatchedPids, 1);
  assert.equal(r.registered.length, 0);
});

test("several matching candidates → most recent activity wins", async () => {
  const r = await backfillLiveClaudeSessions(
    db,
    io([400], { 400: { cwd: "/Users/x/proj", startedAtMs: START } }, [
      candidate({ sessionId: "older", lastActivityMs: START + 1000 }),
      candidate({ sessionId: "newer", lastActivityMs: ACTIVE }),
    ]),
  );
  assert.equal(r.registered[0].id, "newer");
});

test("no first prompt → name falls back to basename(cwd)", async () => {
  const r = await backfillLiveClaudeSessions(
    db,
    io(
      [500],
      { 500: { cwd: "/Users/x/proj", startedAtMs: START } },
      [candidate({ sessionId: "s5", firstPrompt: null })],
    ),
  );
  assert.equal(r.registered[0].name, "proj");
});

test("procInfo null (unverifiable process) → unmatched, nothing registered", async () => {
  const r = await backfillLiveClaudeSessions(
    db,
    io([600], { 600: null }, [candidate({ sessionId: "s6" })]),
  );
  assert.equal(r.unmatchedPids, 1);
  assert.equal(r.registered.length, 0);
});
