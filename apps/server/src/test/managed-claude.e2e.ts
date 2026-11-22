import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeDb } from "./helpers.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import {
  ManagedClaudeManager,
  setManagedClaudeManager,
} from "../core/managed-claude/manager.js";
import { getManagedBinding } from "../core/managed-codex/store.js";
import { getMessage } from "../core/messages.js";
import { registerSession } from "../core/sessions.js";
import { askAndMaybeWake } from "../core/ask.js";
import { stopRuntimeInstance, resumeRuntimeInstance } from "../core/runtime-instances.js";
import Fastify from "fastify";
import { createServerContext, WEB_CONSOLE_ID } from "../http/context.js";
import { registerManagedCodexRoutes } from "../http/routes/managed-codex.js";

const SHIM = fileURLToPath(new URL("./managed-claude-shim.cjs", import.meta.url));

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val !== undefined) return val;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeClaudeFixture() {
  const { db, cleanup } = makeDb();
  const agent = createRuntimeAgent(db, {
    name: "claude-managed-worker",
    runtime: "claude",
    workdir: process.cwd(),
    execution_mode: "managed",
  });
  const launchArgsSeen: string[][] = [];
  const manager = new ManagedClaudeManager(db, {
    resolveLaunch: (_a, opts) => {
      const args = [SHIM];
      if (opts?.resumeThreadId) args.push("--resume", opts.resumeThreadId);
      launchArgsSeen.push(args);
      return {
        executable: process.execPath,
        args,
        cwd: process.cwd(),
        env: { ...process.env },
      };
    },
    rpcOptions: { requestTimeoutMs: 5000 },
  });
  setManagedClaudeManager(manager);
  return {
    db,
    agent,
    manager,
    launchArgsSeen,
    async teardown() {
      setManagedClaudeManager(null);
      await manager.shutdown();
      cleanup();
    },
  };
}

test("managed Claude: FIFO queueing via askAndMaybeWake and one-turn-at-a-time replies", async () => {
  const fx = makeClaudeFixture();
  try {
    const { instance, threadId } = await fx.manager.start(fx.agent);
    assert.ok(threadId.length > 0);
    const binding = getManagedBinding(fx.db, instance.id);
    assert.ok(binding);

    registerSession(fx.db, { id: "caller-1", name: "caller", project_dir: process.cwd() });

    const r1 = await askAndMaybeWake(fx.db, {
      from_session: "caller-1",
      to_session: binding.session_id,
      question: "first-task",
    });
    const r2 = await askAndMaybeWake(fx.db, {
      from_session: "caller-1",
      to_session: binding.session_id,
      question: "second-task",
    });

    const m1 = await waitFor(
      () => {
        const m = getMessage(fx.db, r1.message.id);
        return m?.reply ? m : undefined;
      },
      "first reply",
    );
    const m2 = await waitFor(
      () => {
        const m = getMessage(fx.db, r2.message.id);
        return m?.reply ? m : undefined;
      },
      "second reply",
    );

    assert.equal(m1.reply, "echo:first-task");
    assert.equal(m2.reply, "echo:second-task");
  } finally {
    await fx.teardown();
  }
});

test("managed Claude: Bash and Edit approvals map to canonical kinds and round-trip allow/decline", async () => {
  const fx = makeClaudeFixture();
  try {
    const { instance } = await fx.manager.start(fx.agent);
    const binding = getManagedBinding(fx.db, instance.id)!;
    registerSession(fx.db, { id: "caller-2", name: "caller", project_dir: process.cwd() });

    // 1. Bash -> commandExecution, accept
    const askBash = await askAndMaybeWake(fx.db, {
      from_session: "caller-2",
      to_session: binding.session_id,
      question: "[APPROVE_BASH] run echo",
    });
    const bashPending = await waitFor(() => {
      const st = fx.manager.instanceStatus(instance.id);
      return st?.pendingApprovals[0];
    }, "bash approval pending");

    assert.equal(bashPending.kind, "commandExecution");
    assert.equal(fx.manager.instanceStatus(instance.id)?.activeRun?.state, "waiting_approval");
    assert.equal(
      (bashPending.payload as { command?: string }).command,
      "echo approved-bash",
    );

    const resolvedBash = await fx.manager.resolveApproval(instance.id, bashPending.id, "accept");
    assert.equal(resolvedBash.ok, true);

    const bashReply = await waitFor(() => {
      const m = getMessage(fx.db, askBash.message.id);
      return m?.reply ? m : undefined;
    }, "bash reply");
    assert.equal(bashReply.reply, "bash-allowed:echo approved-bash");

    // 2. Edit -> fileChange, decline
    const askEdit = await askAndMaybeWake(fx.db, {
      from_session: "caller-2",
      to_session: binding.session_id,
      question: "[APPROVE_EDIT] update file",
    });
    const editPending = await waitFor(() => {
      const st = fx.manager.instanceStatus(instance.id);
      return st?.pendingApprovals[0];
    }, "edit approval pending");

    assert.equal(editPending.kind, "fileChange");
    assert.equal(
      (editPending.payload as { filePath?: string }).filePath,
      "/tmp/demo.ts",
    );

    const resolvedEdit = await fx.manager.resolveApproval(instance.id, editPending.id, "decline");
    assert.equal(resolvedEdit.ok, true);

    const editReply = await waitFor(() => {
      const m = getMessage(fx.db, askEdit.message.id);
      return m?.reply ? m : undefined;
    }, "edit reply");
    assert.match(editReply.reply ?? "", /^edit-denied:/);
  } finally {
    await fx.teardown();
  }
});

test("managed Claude: interrupt finalizes turn as interrupted and instance serves next turn", async () => {
  const fx = makeClaudeFixture();
  try {
    const { instance } = await fx.manager.start(fx.agent);
    const binding = getManagedBinding(fx.db, instance.id)!;
    registerSession(fx.db, { id: "caller-3", name: "caller", project_dir: process.cwd() });

    const slow = await askAndMaybeWake(fx.db, {
      from_session: "caller-3",
      to_session: binding.session_id,
      question: "[SLOW] wait forever",
    });

    await waitFor(
      () => (fx.manager.instanceStatus(instance.id)?.activeRun?.state === "running" ? true : undefined),
      "slow turn running",
    );

    const interrupted = await fx.manager.interrupt(instance.id);
    assert.equal(interrupted.accepted, true);

    const slowMsg = await waitFor(() => {
      const m = getMessage(fx.db, slow.message.id);
      return m?.reply ? m : undefined;
    }, "interrupted reply");
    assert.equal(slowMsg.reply, "任务被中断");

    // Instance stays healthy and serves the next turn
    const next = await askAndMaybeWake(fx.db, {
      from_session: "caller-3",
      to_session: binding.session_id,
      question: "after-interrupt",
    });
    const nextMsg = await waitFor(() => {
      const m = getMessage(fx.db, next.message.id);
      return m?.reply ? m : undefined;
    }, "post-interrupt reply");
    assert.equal(nextMsg.reply, "echo:after-interrupt");
  } finally {
    await fx.teardown();
  }
});

test("managed Claude: stop and resume preserves thread_id/session_id via --resume", async () => {
  const fx = makeClaudeFixture();
  try {
    const { instance, threadId } = await fx.manager.start(fx.agent);
    const bindingBefore = getManagedBinding(fx.db, instance.id)!;

    const stopped = await stopRuntimeInstance(fx.db, instance.id);
    assert.equal(stopped.state, "ended");

    const { instance: resumed } = await resumeRuntimeInstance(fx.db, instance.id);
    const bindingAfter = getManagedBinding(fx.db, resumed.id)!;
    assert.equal(bindingAfter.thread_id, threadId, "thread_id preserved across resume");
    assert.equal(bindingAfter.session_id, bindingBefore.session_id, "session_id preserved");
    assert.ok(
      fx.launchArgsSeen.some((args) => args.includes("--resume") && args.includes(threadId)),
      "resume launch passed --resume <threadId>",
    );

    registerSession(fx.db, { id: "caller-4", name: "caller", project_dir: process.cwd() });
    const ask = await askAndMaybeWake(fx.db, {
      from_session: "caller-4",
      to_session: bindingAfter.session_id,
      question: "after-resume",
    });
    const msg = await waitFor(() => {
      const m = getMessage(fx.db, ask.message.id);
      return m?.reply ? m : undefined;
    }, "resumed reply");
    assert.equal(msg.reply, "resumed:after-resume");
  } finally {
    await fx.teardown();
  }
});

test("managed Claude: crash mid-turn marks run unknown and HTTP /managed routes serve Claude instance", async () => {
  const fx = makeClaudeFixture();
  const app = Fastify();
  const ctx = createServerContext(fx.db, { dataDir: process.cwd(), port: 0 });
  registerManagedCodexRoutes(app, ctx);
  try {
    const { instance } = await fx.manager.start(fx.agent);
    const binding = getManagedBinding(fx.db, instance.id)!;

    // Verify HTTP /managed status & events routes resolve the Claude executor via the registry
    const statusRes = await app.inject({
      method: "GET",
      url: `/runtime-instances/${instance.id}/managed`,
      headers: { "x-conflux-session": WEB_CONSOLE_ID },
    });
    assert.equal(statusRes.statusCode, 200);
    const statusBody = statusRes.json() as { binding: { thread_id: string }; current: { live: boolean } };
    assert.equal(statusBody.binding.thread_id, binding.thread_id);
    assert.equal(statusBody.current.live, true);

    registerSession(fx.db, { id: "caller-5", name: "caller", project_dir: process.cwd() });

    await askAndMaybeWake(fx.db, {
      from_session: "caller-5",
      to_session: binding.session_id,
      question: "[CRASH] die now",
    });

    await waitFor(() => {
      const row = fx.db
        .prepare("SELECT state FROM runtime_instances WHERE id = ?")
        .get(instance.id) as { state: string } | undefined;
      return row?.state === "ended" || row?.state === "failed" ? row.state : undefined;
    }, "crashed instance ended");

    const run = fx.db
      .prepare("SELECT state FROM managed_codex_runs WHERE instance_id = ? ORDER BY id DESC LIMIT 1")
      .get(instance.id) as { state: string } | undefined;
    assert.equal(run?.state, "unknown", "crashed mid-turn run marked unknown for review");
  } finally {
    await app.close();
    await fx.teardown();
  }
});
