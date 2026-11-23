import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { makeDb } from "./helpers.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import {
  ManagedAntigravityManager,
  setManagedAntigravityManager,
} from "../core/managed-acp/manager.js";
import { getManagedBinding } from "../core/managed-codex/store.js";
import { getMessage } from "../core/messages.js";
import { registerSession } from "../core/sessions.js";
import { askAndMaybeWake } from "../core/ask.js";
import {
  getRuntimeInstance,
  stopRuntimeInstance,
  resumeRuntimeInstance,
} from "../core/runtime-instances.js";
import { createServerContext, WEB_CONSOLE_ID } from "../http/context.js";
import { registerManagedCodexRoutes } from "../http/routes/managed-codex.js";

const SHIM = fileURLToPath(new URL("./managed-acp-shim.cjs", import.meta.url));

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val !== undefined) return val;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeAcpFixture() {
  const { db, cleanup } = makeDb();
  const agent = createRuntimeAgent(db, {
    name: "agy-managed-worker",
    runtime: "antigravity",
    workdir: process.cwd(),
    instructions: "Always respond concisely.",
    execution_mode: "managed",
  });
  const manager = new ManagedAntigravityManager(db, {
    resolveLaunch: () => ({
      executable: process.execPath,
      args: [SHIM],
      cwd: process.cwd(),
      env: { ...process.env },
    }),
    rpcOptions: { requestTimeoutMs: 5000 },
  });
  setManagedAntigravityManager(manager);
  return {
    db,
    agent,
    manager,
    async teardown() {
      setManagedAntigravityManager(null);
      await manager.shutdown();
      cleanup();
    },
  };
}

test("managed Antigravity (ACP): session/new metadata, MCP injection, and FIFO replies", async () => {
  const fx = makeAcpFixture();
  try {
    const { instance, threadId } = await fx.manager.start(fx.agent);
    assert.ok(threadId.startsWith("acp-sess-"));
    const binding = getManagedBinding(fx.db, instance.id);
    assert.ok(binding);

    registerSession(fx.db, { id: "caller-acp", name: "caller", project_dir: process.cwd() });

    const r1 = await askAndMaybeWake(fx.db, {
      from_session: "caller-acp",
      to_session: binding.session_id,
      question: "inspect-session-new",
    });
    const r2 = await askAndMaybeWake(fx.db, {
      from_session: "caller-acp",
      to_session: binding.session_id,
      question: "hello-agy",
    });

    const m1 = await waitFor(() => {
      const m = getMessage(fx.db, r1.message.id);
      return m?.status === "replied" ? m : undefined;
    }, "inspect-session-new reply");
    const params = JSON.parse(m1.reply ?? "{}") as {
      _meta?: { antigravity?: { systemPrompt?: { append?: string } } };
      mcpServers?: Array<{ name: string }>;
    };
    assert.equal(params._meta?.antigravity?.systemPrompt?.append, "Always respond concisely.");
    assert.ok(Array.isArray(params.mcpServers));
    assert.ok(params.mcpServers.some((s) => s.name === "conflux"));

    const m2 = await waitFor(() => {
      const m = getMessage(fx.db, r2.message.id);
      return m?.status === "replied" ? m : undefined;
    }, "second reply");
    assert.equal(m2.reply, "acp-echo:hello-agy");
  } finally {
    await fx.teardown();
  }
});

test("managed Antigravity (ACP): native optionId approval round-trip & active-turn steer via HTTP", async () => {
  const fx = makeAcpFixture();
  const app = Fastify();
  try {
    const ctx = createServerContext(fx.db, { dataDir: process.cwd(), port: 0 });
    registerManagedCodexRoutes(app, ctx);
    await app.ready();

    const { instance } = await fx.manager.start(fx.agent);
    const binding = getManagedBinding(fx.db, instance.id)!;
    registerSession(fx.db, { id: "caller-acp-2", name: "caller", project_dir: process.cwd() });

    // 1. Permission approval preserving explicit optionId
    const askPerm = await askAndMaybeWake(fx.db, {
      from_session: "caller-acp-2",
      to_session: binding.session_id,
      question: "approve:run-tests",
    });
    const approval = await waitFor(() => {
      const st = fx.manager.instanceStatus(instance.id);
      return st?.pendingApprovals[0];
    }, "ACP approval request");
    assert.equal(approval.kind, "commandExecution");

    const approveResp = await app.inject({
      method: "POST",
      url: `/runtime-instances/${instance.id}/managed/approvals/${approval.id}`,
      headers: { "X-Session-Id": WEB_CONSOLE_ID },
      payload: { decision: "accept", option_id: "opt_allow_once" },
    });
    assert.equal(approveResp.statusCode, 200);

    const permReply = await waitFor(() => {
      const m = getMessage(fx.db, askPerm.message.id);
      return m?.status === "replied" ? m : undefined;
    }, "approval reply");
    assert.equal(permReply.reply, "perm:selected:opt_allow_once");

    // 2. Active-turn steering via HTTP /managed/steer
    const slowAsk = await askAndMaybeWake(fx.db, {
      from_session: "caller-acp-2",
      to_session: binding.session_id,
      question: "slow:task",
    });
    await waitFor(() => {
      const st = fx.manager.instanceStatus(instance.id);
      return st?.activeRun ? st.activeRun : undefined;
    }, "active slow turn");

    const steerResp = await app.inject({
      method: "POST",
      url: `/runtime-instances/${instance.id}/managed/steer`,
      headers: { "X-Session-Id": WEB_CONSOLE_ID },
      payload: { text: "pivot-now" },
    });
    assert.equal(steerResp.statusCode, 200);
    assert.equal(steerResp.json().accepted, true);

    const steeredReply = await waitFor(() => {
      const m = getMessage(fx.db, slowAsk.message.id);
      return m?.status === "replied" ? m : undefined;
    }, "steered reply");
    assert.ok((steeredReply.reply ?? "").includes("steered:pivot-now"));

    // 3. Stop + resume keeps saved ACP thread id and serves another turn
    await stopRuntimeInstance(fx.db, instance.id);
    const resumed = await resumeRuntimeInstance(fx.db, instance.id);
    assert.equal(getRuntimeInstance(fx.db, resumed.instance.id)?.state, "running");
    assert.equal(getManagedBinding(fx.db, resumed.instance.id)?.thread_id, binding.thread_id);

    const postResume = await askAndMaybeWake(fx.db, {
      from_session: "caller-acp-2",
      to_session: binding.session_id,
      question: "stream-chunks",
    });
    const postResumeReply = await waitFor(() => {
      const m = getMessage(fx.db, postResume.message.id);
      return m?.status === "replied" ? m : undefined;
    }, "post-resume acp streamed reply");
    assert.equal(postResumeReply.reply, "Alpha Beta Gamma.");
  } finally {
    await app.close();
    await fx.teardown();
  }
});
