import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { getMessage } from "../core/messages.js";
import { registerSession } from "../core/sessions.js";
import type { RuntimeAgent } from "@conflux/shared";
import { ManagedCodexManager, setManagedCodexManager } from "../core/managed-codex/manager.js";

// Crash-window reconciliation (real child processes — SERIAL *.e2e.ts suite):
// every run interrupted by a dead generation is resolved from EVIDENCE —
// the thread's durable history — never by replaying. The four windows:
// before send (@noack), after send before completion (@hold), completed but
// unprocessed (@silent), and approvals mid-flight. Queue survives; send
// counts are asserted from the shim's on-disk log across BOTH processes.

const shimPath = resolve(__dirname, "managed-codex-shim.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined, ms = 10000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

interface Fixture {
  db: DB;
  dir: string;
  logPath: string;
  agent: RuntimeAgent;
  manager: () => ManagedCodexManager;
  sessionId: () => string;
  dispose: () => Promise<void>;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-recovery-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const agent = createRuntimeAgent(db, {
    name: "recovery fixture",
    runtime: "codex",
    workdir: projectDir,
    execution_mode: "managed",
  });
  const logPath = join(dir, "shim-rpc.log");
  const historyPath = join(dir, "shim-history.log");
  const mkManager = () =>
    new ManagedCodexManager(db, {
      resolveLaunch: () => ({
        executable: shimPath,
        args: [],
        env: {
          ...process.env,
          SHIM_LOG: logPath,
          SHIM_HISTORY: historyPath,
          SHIM_CWD: projectDir,
        },
        cwd: projectDir,
      }),
      // Short timeouts so the @noack crash window rejects in seconds, not
      // the production 30s budget.
      rpcOptions: { requestTimeoutMs: 1500 },
    });
  return {
    db,
    dir,
    logPath,
    agent,
    manager: mkManager,
    // The managed session id is derived from the instance; read it lazily so
    // it follows rebindings (the instance id changes across resume).
    sessionId: () =>
      (
        db
          .prepare(`SELECT session_id FROM managed_codex_bindings ORDER BY updated_at DESC LIMIT 1`)
          .get() as { session_id: string }
      ).session_id,
    dispose: async () => {
      setManagedCodexManager(null);
      stopWalCheckpoint(db);
      db.close();
      // Windows releases child-process cwd handles with a delay; retry a
      // few times before giving up (the temp dir is disposable anyway).
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          await sleep(200);
        }
      }
    },
  };
}

function insertAsk(fx: Fixture, question: string): number {
  registerSession(fx.db, { id: "asker", name: "asker" });
  fx.db
    .prepare(
      `INSERT INTO messages (from_session, to_session, question, status, created_at)
       VALUES ('asker', ?, ?, 'pending', ?)`,
    )
    .run(fx.sessionId(), question, new Date().toISOString());
  return Number(
    (fx.db.prepare(`SELECT id FROM messages WHERE question = ?`).get(question) as { id: number }).id,
  );
}

function runRow(fx: Fixture, messageId: number) {
  return fx.db
    .prepare(`SELECT id, state, turn_id, error_code, instance_id FROM managed_codex_runs WHERE message_id = ?`)
    .get(messageId) as
    | { id: number; state: string; turn_id: string | null; error_code: string | null; instance_id: string }
    | undefined;
}

function turnStartCount(fx: Fixture, needle = "turn/start"): number {
  try {
    return readFileSync(fx.logPath, "utf8")
      .split("\n")
      .filter((l) => l.includes(needle)).length;
  } catch {
    return 0;
  }
}

test("queued tasks survive a crash and continue on the resumed instance", async () => {
  const fx = makeFixture();
  try {
    const manager = fx.manager();
    setManagedCodexManager(manager);
    const { instance } = await manager.start(fx.agent);
    const first = insertAsk(fx, "@hold blocking task");
    const second = insertAsk(fx, "queued survivor");
    await manager.enqueue({ messageId: first, instanceId: instance.id, text: "@hold blocking task" });
    await waitFor(() => (runRow(fx, first)?.state === "running" ? true : undefined), 10000, "first running");
    await manager.enqueue({ messageId: second, instanceId: instance.id, text: "queued survivor" });
    assert.equal(turnStartCount(fx), 1);

    manager.crashForTest(instance.id);
    await waitFor(
      () => (runRow(fx, first)?.state === "unknown" ? true : undefined),
      10000,
      "crashed run unknown",
    );

    await manager.resumeInstance(instance.id, fx.agent);
    // The held turn never completed → no history evidence → stays unknown.
    await waitFor(
      () => (runRow(fx, first)?.state === "unknown" ? true : undefined),
      10000,
      "first stays unknown",
    );
    assert.match(runRow(fx, first)!.error_code ?? "", /crash window|history|mid-turn/);
    // The queued task migrated and ran on the new instance.
    await waitFor(
      () => (runRow(fx, second)?.state === "completed" ? true : undefined),
      10000,
      "queued survivor completed",
    );
    assert.equal(getMessage(fx.db, second)!.reply, "shim final answer");
    assert.equal(turnStartCount(fx), 2, "exactly one turn/start per executed task");
    assert.notEqual(runRow(fx, second)!.instance_id, instance.id);
    await manager.shutdown();
  } finally {
    await fx.dispose();
  }
});

test("the send-before-ack window goes unknown and is never resubmitted", async () => {
  const fx = makeFixture();
  try {
    const manager = fx.manager();
    setManagedCodexManager(manager);
    const { instance } = await manager.start(fx.agent);
    const noack = insertAsk(fx, "@noack unacknowledged");
    const follower = insertAsk(fx, "follower task");
    // Fire the enqueue WITHOUT awaiting it: the pump's turn/start hangs
    // until the (short) request timeout, which is the crash window itself.
    const firstEnqueue = manager.enqueue({
      messageId: noack,
      instanceId: instance.id,
      text: "@noack unacknowledged",
    });
    await waitFor(
      () => (turnStartCount(fx, '"method":"turn/start"') >= 1 ? true : undefined),
      10000,
      "turn/start sent",
    );
    // The run is in submitting with the request in flight. Queue the
    // follower, then kill the child BEFORE the ack can ever arrive.
    await manager.enqueue({ messageId: follower, instanceId: instance.id, text: "follower task" });
    manager.crashForTest(instance.id);
    await firstEnqueue.catch(() => {});
    await waitFor(
      () => (runRow(fx, noack) ? true : undefined),
      10000,
      "run row exists",
    );

    await manager.resumeInstance(instance.id, fx.agent);
    await waitFor(
      () => (runRow(fx, noack)?.state === "unknown" ? true : undefined),
      10000,
      "noack unknown",
    );
    assert.match(runRow(fx, noack)!.error_code ?? "", /unverifiable|crash window|history|mid-turn/);
    // Follower runs; the unverifiable task is NOT replayed.
    await waitFor(
      () => (runRow(fx, follower)?.state === "completed" ? true : undefined),
      10000,
      "follower completed",
    );
    const starts = turnStartCount(fx, "turn/start");
    const noackFrames = readFileSync(fx.logPath, "utf8")
      .split("\n")
      .filter((l) => l.includes('"method":"turn/start"') && l.includes("@noack"));
    assert.equal(noackFrames.length, 1, "the unverifiable task was sent exactly once");
    assert.equal(starts, 2, "only the follower got a second turn/start");
    await manager.shutdown();
  } finally {
    await fx.dispose();
  }
});

test("completed-but-unprocessed turns are finalized from thread history", async () => {
  const fx = makeFixture();
  try {
    const manager = fx.manager();
    setManagedCodexManager(manager);
    const { instance } = await manager.start(fx.agent);
    const silent = insertAsk(fx, "@silent done but unprocessed");
    await manager.enqueue({
      messageId: silent,
      instanceId: instance.id,
      text: "@silent done but unprocessed",
    });
    // The shim finishes and records history but emits no turn/completed, so
    // the run stays running — exactly the died-before-write-back window.
    await waitFor(
      () => (runRow(fx, silent)?.state === "running" ? true : undefined),
      10000,
      "running",
    );
    await sleep(400); // let the shim finish and persist history
    manager.crashForTest(instance.id);

    const { reconciliation } = await manager.resumeInstance(instance.id, fx.agent);
    await waitFor(
      () => (runRow(fx, silent)?.state === "completed" ? true : undefined),
      10000,
      "finalized from history",
    );
    assert.equal(getMessage(fx.db, silent)!.status, "replied");
    assert.equal(getMessage(fx.db, silent)!.reply, "shim final answer");
    assert.ok(reconciliation.some((r) => r.includes("completed per history")));
    assert.equal(turnStartCount(fx), 1, "the finished task was never replayed");
    await manager.shutdown();
  } finally {
    await fx.dispose();
  }
});

test("mid-approval crashes expire the approval and mark the run unknown", async () => {
  const fx = makeFixture();
  try {
    const manager = fx.manager();
    setManagedCodexManager(manager);
    const { instance } = await manager.start(fx.agent);
    const messageId = insertAsk(fx, "@approval interrupted by crash");
    await manager.enqueue({
      messageId,
      instanceId: instance.id,
      text: "@approval interrupted by crash",
    });
    await waitFor(
      () => (runRow(fx, messageId)?.state === "waiting_approval" ? true : undefined),
      10000,
      "waiting_approval",
    );
    manager.crashForTest(instance.id);

    const resumed = await manager.resumeInstance(instance.id, fx.agent);
    const approval = fx.db
      .prepare(`SELECT state FROM managed_codex_approvals`)
      .get() as { state: string };
    assert.equal(approval.state, "expired", "the dead connection's approval must expire");
    await waitFor(
      () => (runRow(fx, messageId)?.state === "unknown" ? true : undefined),
      10000,
      "approval run unknown",
    );
    // The expired approval cannot be answered on the new generation.
    const late = await manager.resolveApproval(resumed.instance.id, 1, "accept");
    assert.equal((late as { status: number }).status, 409);
    await manager.shutdown();
  } finally {
    await fx.dispose();
  }
});

test("resume refuses while the previous app-server process still lives", async () => {
  const fx = makeFixture();
  try {
    const manager = fx.manager();
    setManagedCodexManager(manager);
    const { instance } = await manager.start(fx.agent);
    const messageId = insertAsk(fx, "@hold while dying");
    await manager.enqueue({ messageId, instanceId: instance.id, text: "@hold while dying" });
    await waitFor(() => (runRow(fx, messageId)?.state === "running" ? true : undefined), 10000, "running");

    // Simulate "manager died, child survived": forget the instance WITHOUT
    // killing the child, then try to resume its binding.
    const livePid = manager.getLiveInstanceIds();
    assert.equal(livePid.length, 1);
    manager.forgetForTest(instance.id);
    await assert.rejects(manager.resumeInstance(instance.id, fx.agent), /still running/);
    // Cleanup: re-adopt then graceful shutdown kills the child.
    manager.adoptForTest(instance.id);
    await manager.shutdown();
  } finally {
    await fx.dispose();
  }
});

test("concurrent stop and resume serialize: no second writer while the old child lingers", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "managed-codex-linger-"));
  const db = openDb({ dataDir: dir2, dbPath: join(dir2, "data.db"), scope: "global" });
  const projectDir = join(dir2, "project");
  mkdirSync(projectDir, { recursive: true });
  const agent = createRuntimeAgent(db, {
    name: "linger",
    runtime: "codex",
    workdir: projectDir,
    execution_mode: "managed",
  });
  const manager = new ManagedCodexManager(db, {
    resolveLaunch: () => ({
      executable: shimPath,
      args: [],
      // SHIM_LINGER (POSIX): the child ignores the first SIGTERM and exits
      // 1500ms later — exactly the delayed-termination window in which a
      // naive resume would start a SECOND writer for the same thread.
      env: {
        ...process.env,
        SHIM_LOG: join(dir2, "shim.log"),
        SHIM_HISTORY: join(dir2, "hist.log"),
        SHIM_CWD: projectDir,
        SHIM_LINGER: "1",
      },
      cwd: projectDir,
    }),
    rpcOptions: { requestTimeoutMs: 1500 },
  });
  setManagedCodexManager(manager);
  try {
    const { instance } = await manager.start(agent);
    const oldPid = (
      db.prepare(`SELECT runtime_pid FROM runtime_instances WHERE id = ?`).get(instance.id) as {
        runtime_pid: number;
      }
    ).runtime_pid;

    // Fire the official stop and immediately the official resume, WITHOUT
    // awaiting the stop: the old child is still alive (lingering).
    const stopPromise = (async () => {
      await manager.stopManagedInstance(instance.id);
    })().catch(() => {});
    const resumePromise = manager.resumeInstance(instance.id, agent, {
      confirmExitBudgetMs: 15000,
    });
    await stopPromise;
    const resumed = await resumePromise;

    // The resume only proceeded once the OLD child had actually exited —
    // never before, so at no point were two writers alive for the thread.
    const oldRow = db
      .prepare(`SELECT state, ended_at FROM runtime_instances WHERE id = ?`)
      .get(instance.id) as { state: string; ended_at: string };
    assert.equal(oldRow.state, "ended");
    const newRow = db
      .prepare(`SELECT state FROM runtime_instances WHERE id = ?`)
      .get(resumed.instance.id) as { state: string };
    assert.equal(newRow.state, "running");
    void oldPid;
    await manager.stopManagedInstance(resumed.instance.id).catch(async () => {
      await manager.shutdown();
    });
  } finally {
    await manager.shutdown();
    setManagedCodexManager(null);
    stopWalCheckpoint(db);
    db.close();
    try {
      rmSync(dir2, { recursive: true, force: true });
    } catch {
      // lingering handles on Windows; temp dir is disposable
    }
  }
});
