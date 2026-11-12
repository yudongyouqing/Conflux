import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { completeAsk, prepareAsk } from "../core/ask.js";
import { registerSession } from "../core/sessions.js";
import { getMessage } from "../core/messages.js";
import type { RuntimeAgent } from "@conflux/shared";
import {
  getManagedCodexManager,
  ManagedCodexManager,
  setManagedCodexManager,
} from "../core/managed-codex/manager.js";
import type { ManagedRunState } from "../core/managed-codex/types.js";

// End-to-end manager behavior against the controllable app-server shim
// (real child processes — lives in the SERIAL *.e2e.ts suite; the parallel
// unit-suite load starves the shim past its windows, like every other
// process e2e in this repo):
// start binds a REAL thread id before the instance counts as running, one
// turn runs at a time with queueing behind it, terminal states write the
// reply exactly once, failures and interrupts never masquerade as
// completed, and the ask path dispatches to the executor instead of a
// terminal wake.

const shimPath = resolve(__dirname, "managed-codex-shim.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined, ms = 8000, what = "condition"): Promise<T> {
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
  manager: ManagedCodexManager;
  agent: RuntimeAgent;
  sessionId: string;
  instanceId: string;
  logPath: string;
  dispose: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-manager-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const agent = createRuntimeAgent(db, {
    name: "managed fixture",
    runtime: "codex",
    workdir: projectDir,
    execution_mode: "managed",
  });
  const logPath = join(dir, "shim-rpc.log");
  const manager = new ManagedCodexManager(db, {
    resolveLaunch: () => ({
      executable: shimPath,
      args: [],
      env: { ...process.env, SHIM_LOG: logPath, SHIM_CWD: projectDir },
      cwd: projectDir,
    }),
  });
  setManagedCodexManager(manager);
  const { instance } = await manager.start(agent);
  const binding = db
    .prepare(`SELECT * FROM managed_codex_bindings WHERE instance_id = ?`)
    .get(instance.id) as { session_id: string; thread_id: string };
  const dispose = async () => {
    await manager.shutdown();
    setManagedCodexManager(null);
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    db,
    dir,
    manager,
    agent,
    sessionId: binding.session_id,
    instanceId: instance.id,
    logPath,
    dispose,
  };
}

function insertAsk(fx: Fixture, question: string): number {
  registerSession(fx.db, { id: "asker", name: "asker" });
  fx.db
    .prepare(
      `INSERT INTO messages (from_session, to_session, question, status, created_at)
       VALUES ('asker', ?, ?, 'pending', ?)`,
    )
    .run(fx.sessionId, question, new Date().toISOString());
  return Number(
    (fx.db.prepare(`SELECT id FROM messages WHERE question = ?`).get(question) as { id: number })
      .id,
  );
}

function runState(fx: Fixture, messageId: number): ManagedRunState | undefined {
  return (
    fx.db
      .prepare(`SELECT state FROM managed_codex_runs WHERE message_id = ?`)
      .get(messageId) as { state: ManagedRunState } | undefined
  )?.state;
}

function shimLog(fx: Fixture): string[] {
  try {
    return readFileSync(fx.logPath, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("start binds a real thread id and flips the instance to running", async () => {
  const fx = await makeFixture();
  try {
    assert.equal(fx.instanceId.length > 0, true);
    const binding = fx.db
      .prepare(`SELECT * FROM managed_codex_bindings WHERE instance_id = ?`)
      .get(fx.instanceId) as { thread_id: string; session_id: string; owner_token: string };
    assert.equal(binding.thread_id, "shim-thread-0001", "thread id must come from the protocol");
    assert.ok(binding.owner_token);
    const instanceRow = fx.db
      .prepare(`SELECT state FROM runtime_instances WHERE id = ?`)
      .get(fx.instanceId) as { state: string };
    assert.equal(instanceRow.state, "running");
    const session = fx.db
      .prepare(`SELECT runtime, metadata FROM sessions WHERE id = ?`)
      .get(fx.sessionId) as { runtime: string; metadata: string };
    assert.equal(session.runtime, "codex");
    const meta = JSON.parse(session.metadata) as { runtime_instance_id: string };
    assert.equal(meta.runtime_instance_id, fx.instanceId);
  } finally {
    await fx.dispose();
  }
});

test("an instance whose app-server never initializes fails, not starting forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-dead-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  try {
    const agent = createRuntimeAgent(db, {
      name: "dead",
      runtime: "codex",
      execution_mode: "managed",
    });
    const manager = new ManagedCodexManager(db, {
      // A command that exits immediately: initialize can never complete.
      resolveLaunch: () => ({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { ...process.env },
        cwd: dir,
      }),
    });
    await assert.rejects(manager.start(agent), /exited|initialize|timed out|closed/i);
    const rows = db.prepare(`SELECT state FROM runtime_instances`).all() as { state: string }[];
    assert.equal(rows[0]?.state, "failed");
    setManagedCodexManager(null);
  } finally {
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task on an idle instance runs to completion and replies once", async () => {
  const fx = await makeFixture();
  try {
    const messageId = insertAsk(fx, "plain fixture task");
    await fx.manager.enqueue({ messageId, instanceId: fx.instanceId, text: "plain fixture task" });

    await waitFor(() => (runState(fx, messageId) === "completed" ? true : undefined), 8000, "completion");
    const msg = getMessage(fx.db, messageId)!;
    assert.equal(msg.status, "replied");
    assert.equal(msg.reply, "shim final answer");
    // exactly one turn/start and one reply write
    const turns = shimLog(fx).filter((l) => l.includes('"method":"turn/start"'));
    assert.equal(turns.length, 1);
    assert.equal(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id = ? AND status='replied'`).get(messageId) as { n: number }).n,
      1,
    );
    // events were persisted for the run
    const events = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM managed_codex_events WHERE instance_id = ?`)
      .get(fx.instanceId) as { n: number };
    assert.ok(events.n >= 3, "turn lifecycle events recorded");
  } finally {
    await fx.dispose();
  }
});

test("a second task queues behind a held turn and runs after release", async () => {
  const fx = await makeFixture();
  try {
    const first = insertAsk(fx, "@hold first");
    const second = insertAsk(fx, "second plain");
    await fx.manager.enqueue({ messageId: first, instanceId: fx.instanceId, text: "@hold first" });
    await waitFor(() => (runState(fx, first) === "running" ? true : undefined), 8000, "first running");
    await fx.manager.enqueue({
      messageId: second,
      instanceId: fx.instanceId,
      text: "second plain",
    });
    await sleep(300);
    // only one turn/start has been sent while the first is held
    assert.equal(shimLog(fx).filter((l) => l.includes('"method":"turn/start"')).length, 1);
    assert.equal(runState(fx, second), "queued");

    // release the held turn via the shim's test/release RPC
    const live = getManagedCodexManager()!;
    await (live as unknown as { instances: Map<string, { proc: { conn: { request: (m: string, p?: unknown) => Promise<unknown> } } }> })
      .instances.get(fx.instanceId)!.proc.conn.request("test/release", {});

    await waitFor(() => (runState(fx, first) === "completed" ? true : undefined), 8000, "first completed");
    await waitFor(() => (runState(fx, second) === "completed" ? true : undefined), 8000, "second completed");
    assert.equal(getMessage(fx.db, first)!.reply, "shim final answer");
    assert.equal(getMessage(fx.db, second)!.reply, "shim final answer");
    assert.equal(shimLog(fx).filter((l) => l.includes('"method":"turn/start"')).length, 2);
  } finally {
    await fx.dispose();
  }
});

test("a failed turn writes a failure reply, never completed", async () => {
  const fx = await makeFixture();
  try {
    const messageId = insertAsk(fx, "@fail task");
    await fx.manager.enqueue({ messageId, instanceId: fx.instanceId, text: "@fail task" });
    await waitFor(() => (runState(fx, messageId) === "failed" ? true : undefined), 8000, "failure");
    const run = fx.db
      .prepare(`SELECT state, error_code FROM managed_codex_runs WHERE message_id = ?`)
      .get(messageId) as { state: string; error_code: string };
    assert.equal(run.state, "failed");
    assert.match(run.error_code, /shim model failure fixture/);
    const msg = getMessage(fx.db, messageId)!;
    assert.equal(msg.status, "replied");
    assert.match(msg.reply!, /失败/);
  } finally {
    await fx.dispose();
  }
});

test("interrupt finalizes the active turn as interrupted", async () => {
  const fx = await makeFixture();
  try {
    const messageId = insertAsk(fx, "@hold interrupt me");
    await fx.manager.enqueue({
      messageId,
      instanceId: fx.instanceId,
      text: "@hold interrupt me",
    });
    await waitFor(() => (runState(fx, messageId) === "running" ? true : undefined), 8000, "running");

    const stale = await fx.manager.interrupt(fx.instanceId, "wrong-turn-id");
    assert.equal(stale.accepted, false, "expected-turn mismatch refuses the interrupt");
    const result = await fx.manager.interrupt(fx.instanceId);
    assert.equal(result.accepted, true);

    await waitFor(
      () => (runState(fx, messageId) === "interrupted" ? true : undefined),
      8000,
      "interrupted",
    );
    const msg = getMessage(fx.db, messageId)!;
    assert.equal(msg.status, "replied");
    assert.match(msg.reply!, /中断/);
    const none = await fx.manager.interrupt(fx.instanceId);
    assert.equal(none.accepted, false, "idle instance has nothing to interrupt");
  } finally {
    await fx.dispose();
  }
});

test("the ask path dispatches managed targets without any terminal wake", async () => {
  const fx = await makeFixture();
  try {
    registerSession(fx.db, { id: "asker", name: "asker" });
    let wakeRuns = 0;
    const outcome = await completeAsk(
      fx.db,
      prepareAsk(fx.db, {
        from_session: "asker",
        to_session: fx.sessionId,
        question: "ask-routed fixture",
      }),
      () => {
        wakeRuns++;
        return { woke: false, reason: "must not be called" };
      },
    );
    assert.equal(wakeRuns, 0, "managed targets never take the terminal wake path");
    assert.equal(outcome.wake.woke, true);
    assert.match(String((outcome.wake as { command?: string }).command ?? ""), /managed-codex/);
    const messageId = outcome.message.id;
    await waitFor(
      () => (runState(fx, messageId) === "completed" ? true : undefined),
      8000,
      "completion",
    );
    assert.equal(getMessage(fx.db, messageId)!.reply, "shim final answer");
    const delivery = fx.db
      .prepare(`SELECT state FROM message_deliveries WHERE message_id = ?`)
      .get(messageId) as { state: string };
    assert.equal(delivery.state, "woken");
  } finally {
    await fx.dispose();
  }
});

test("shutdown marks the active run unknown and ends the instance", async () => {
  const fx = await makeFixture();
  const messageId = insertAsk(fx, "@hold during shutdown");
  await fx.manager.enqueue({
    messageId,
    instanceId: fx.instanceId,
    text: "@hold during shutdown",
  });
  await waitFor(() => (runState(fx, messageId) === "running" ? true : undefined), 8000, "running");
  await fx.manager.shutdown();
  assert.equal(runState(fx, messageId), "unknown");
  const instanceRow = fx.db
    .prepare(`SELECT state FROM runtime_instances WHERE id = ?`)
    .get(fx.instanceId) as { state: string };
  assert.equal(instanceRow.state, "ended");
  // second shutdown is a no-op
  await fx.manager.shutdown();
  setManagedCodexManager(null);
  stopWalCheckpoint(fx.db);
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
});
