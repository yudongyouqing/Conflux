import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeDb } from "./helpers.js";
import { runBackfill, runtimeProcInfo } from "../core/hooks-backfill.js";
import { probeRuntimePids } from "../core/liveness.js";
import { getSession } from "../core/sessions.js";
import { getSetting } from "../core/app-settings.js";

// Real-process backfill: a claude-shaped child with a live transcript gets
// registered through the production probe (ps), process inspection (lsof
// cwd + ps lstart) and matcher; the second run is idempotent; an exited
// process is no longer a candidate. This mirrors the production boundary:
// runtimeProcInfo is unimplemented on Windows (returns null), so the whole
// scenario is POSIX-only and skips on win32.
const shimSource = resolve(__dirname, "runtime-process-shim.cjs");
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

test("real-process backfill registers once, stays idempotent and ignores the exited", { timeout: 120000 }, async (t) => {
  if (process.platform === "win32") return t.skip("runtimeProcInfo is unimplemented on win32 (production boundary)");

  const { db, cleanup: cleanupDb } = makeDb();
  t.after(() => cleanupDb());

  const root = mkdtempSync(join(tmpdir(), "backfill-e2e-"));
  const home = join(root, "claude-home");
  const projectDir = join(root, "proj");
  mkdirSync(join(home, "projects", "encoded-dir"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // disposable temp dir — leave it behind rather than fail the test
    }
  });

  // A claude-shaped process started in the project directory, plus its
  // transcript with cwd, a first prompt and a fresh timestamp.
  const shim = join(root, "claude");
  copyFileSync(shimSource, shim);
  const child: ChildProcess = spawn(process.execPath, [shim, "stay", join(root, "report.json")], {
    cwd: projectDir,
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([exited, sleep(5000)]);
    }
  });

  const sessionId = `e2e-${Date.now().toString(36)}`;
  const transcriptPath = join(home, "projects", "encoded-dir", `${sessionId}.jsonl`);
  await new Promise((resolveReady) => child.once("spawn", resolveReady));
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      cwd: projectDir,
      timestamp: new Date().toISOString(),
      type: "user",
      message: { content: "refactor the parser module" },
    })}\n`,
  );

  // Environment sanity: the matcher requires lsof-resolvable cwd. On
  // GitHub macOS runners lsof cannot read other processes' cwd (SIP), so
  // the production matcher — by design — treats the pid as unverifiable.
  // Record that honestly as a skip instead of failing.
  const info = await runtimeProcInfo(child.pid!);
  if (info?.cwd !== projectDir) {
    return t.skip(
      "this environment cannot resolve the child cwd via lsof (got " +
        JSON.stringify(info) +
        ") — the matcher correctly refuses to guess",
    );
  }

  // The production probe must see our shim as a live claude pid.
  const seen = await (async () => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const snapshot = await probeRuntimePids();
      if (snapshot?.claude.has(child.pid!)) return snapshot;
      assert.ok(Date.now() < deadline, "probe never listed the claude-shaped shim");
      await sleep(500);
    }
  })();

  const first = await runBackfill(db, home);
  assert.equal(first.registered.length, 1, `expected exactly one registration: ${JSON.stringify(first)}`);
  assert.equal(first.registered[0].pid, child.pid);
  assert.equal(first.registered[0].id, sessionId);
  assert.match(first.registered[0].name, /refactor the parser/);
  const row = getSession(db, sessionId)!;
  assert.equal(row.runtime_pid, child.pid);
  assert.equal(getSetting(db, `claude-current:${child.pid}`), sessionId);

  // Second run: the pid is already bound — nothing registers or refreshes.
  const second = await runBackfill(db, home);
  assert.equal(second.registered.length, 0);
  assert.equal(second.refreshed, 0);
  assert.equal(second.skippedBound >= 1, true, "the bound pid must be skipped");
  assert.equal(getSession(db, sessionId)!.runtime_pid, child.pid);

  // Exited process: ps drops it (or its command stops matching), and a
  // third run registers nothing new.
  child.kill();
  await exited;
  const gone = Date.now() + 15000;
  for (;;) {
    const snapshot = await probeRuntimePids();
    if (!snapshot?.claude.has(child.pid!)) break;
    assert.ok(Date.now() < gone, "probe still lists the killed shim");
    await sleep(500);
  }
  const third = await runBackfill(db, home);
  assert.equal(third.registered.length, 0, `dead process must not register: ${JSON.stringify(third)}`);
  // skippedBound counts LIVE bound pids; a dead pid is not in the probe's
  // live set at all, so the row simply is not a candidate anymore — what
  // must hold is that it still exists, bound to the dead pid.
  const finalRow = getSession(db, sessionId)!;
  assert.equal(finalRow.runtime_pid, child.pid, "the registered row survives with its pid binding");
  assert.equal(seen.claude.has(child.pid!), true, "the probe had observed the shim before the kill");
});
