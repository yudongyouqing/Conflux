import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers.js";
import {
  parseTranscriptCandidate,
  scanRecentTranscripts,
} from "../core/hooks-backfill.js";

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
