import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { WEB_CONSOLE_ID } from "@conflux/shared";
import { makeDb } from "./helpers.js";
import { registerSession } from "../core/sessions.js";
import { createChatRoom } from "../core/chat-rooms.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import {
  ManagedAntigravityManager,
  setManagedAntigravityManager,
} from "../core/managed-acp/manager.js";
import { getManagedBinding } from "../core/managed-codex/store.js";
import {
  installManagedOrchestrationHooks,
  readRoom,
  summonAgent,
} from "../core/room-orchestrator.js";
import {
  approveHumanGate,
  createWorkflow,
  getWorkflowRun,
  startWorkflowRun,
} from "../core/workflows.js";
import { publishContext, listRoomContext } from "../core/context.js";
import { queryContext } from "../core/search.js";
import { handoffContext } from "../core/handoff.js";
import { getMessage, replyAsk } from "../core/messages.js";
import {
  installManagedLiveEventBridge,
  publishLiveEvent,
  replayLiveEventsAfter,
  resetLiveEventBusForTest,
} from "../core/event-bus.js";
import { createServerContext } from "../http/context.js";
import { registerWorkflowRoutes } from "../http/routes/workflows.js";
import { registerContextRoutes } from "../http/routes/context.js";

const ACP_SHIM = fileURLToPath(new URL("./managed-acp-shim.cjs", import.meta.url));

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("room orchestrator fuses with ManagedExecutor: summon routes natively and auto-finalizes room_task", async () => {
  const { db, cleanup } = makeDb();
  installManagedOrchestrationHooks();
  installManagedLiveEventBridge();
  const agent = createRuntimeAgent(db, {
    name: "agy-room-worker",
    runtime: "antigravity",
    workdir: process.cwd(),
    execution_mode: "managed",
  });
  const manager = new ManagedAntigravityManager(db, {
    resolveLaunch: () => ({
      executable: process.execPath,
      args: [ACP_SHIM],
      cwd: process.cwd(),
      env: { ...process.env },
    }),
    rpcOptions: { requestTimeoutMs: 5000 },
  });
  setManagedAntigravityManager(manager);

  try {
    const { instance } = await manager.start(agent);
    const binding = getManagedBinding(db, instance.id)!;
    registerSession(db, { id: WEB_CONSOLE_ID, name: "Web Console" });
    const room = createChatRoom(db, { name: "Fusion Room", members: [binding.session_id] });

    const res = summonAgent(db, {
      room_id: room.id,
      initiator_session_id: WEB_CONSOLE_ID,
      executor_session_id: binding.session_id,
      prompt: "summarize-spec",
    });
    assert.equal(res.injected, true);
    assert.equal(res.method, "managed");

    const doneTask = await waitFor(() => {
      const { tasks } = readRoom(db, room.id);
      const t = tasks.find((row) => row.id === res.task.id);
      return t?.status === "done" ? t : undefined;
    }, "managed room task completion");

    assert.ok((doneTask.result ?? "").includes("summarize-spec"));
  } finally {
    setManagedAntigravityManager(null);
    await manager.shutdown();
    cleanup();
  }
});

test("workflow DAG: rejects cycles, drives managed + human_gate + parallel fan-out + handoff", async () => {
  const { db, cleanup } = makeDb();
  installManagedOrchestrationHooks();
  const agent = createRuntimeAgent(db, {
    name: "agy-dag-node",
    runtime: "antigravity",
    workdir: process.cwd(),
    execution_mode: "managed",
  });
  const manager = new ManagedAntigravityManager(db, {
    resolveLaunch: () => ({
      executable: process.execPath,
      args: [ACP_SHIM],
      cwd: process.cwd(),
      env: { ...process.env },
    }),
    rpcOptions: { requestTimeoutMs: 5000 },
  });
  setManagedAntigravityManager(manager);

  try {
    const { instance } = await manager.start(agent);
    const managedSid = getManagedBinding(db, instance.id)!.session_id;
    registerSession(db, { id: WEB_CONSOLE_ID, name: "Web Console" });
    registerSession(db, { id: "ext-reviewer", name: "External Reviewer", project_dir: process.cwd() });
    const room = createChatRoom(db, { name: "DAG Room", members: [managedSid, "ext-reviewer"] });

    // Structured pinned decision memory in room
    const decision = publishContext(db, {
      session_id: WEB_CONSOLE_ID,
      room_id: room.id,
      kind: "decision",
      pinned: true,
      title: "Use ACP for Antigravity",
      content: "Keep fs.writeTextFile false and pass mcpServers on session/new.",
      tags: ["arch"],
    });
    assert.equal(decision.kind, "decision");
    assert.equal(decision.pinned, true);
    assert.equal(listRoomContext(db, room.id).length, 1);
    assert.equal(queryContext(db, { room_id: room.id, kind: "decision", pinned: true }).length, 1);

    // Cycle validation
    assert.throws(
      () =>
        createWorkflow(db, {
          name: "Bad Cyclic Workflow",
          room_id: room.id,
          steps: [
            { key: "a", title: "A", kind: "agent", depends_on: ["b"], target_session_id: managedSid, prompt_template: "a" },
            { key: "b", title: "B", kind: "agent", depends_on: ["a"], target_session_id: managedSid, prompt_template: "b" },
          ],
        }),
      /cycle/i,
    );

    // Valid DAG: plan (managed) -> gate (human_gate) -> impl (managed, with handoff)
    const wf = createWorkflow(db, {
      name: "Plan-Approve-Implement",
      room_id: room.id,
      steps: [
        {
          key: "plan",
          title: "Plan",
          kind: "agent",
          depends_on: [],
          target_session_id: managedSid,
          prompt_template: "plan:{{input}}",
        },
        {
          key: "gate",
          title: "Human Review",
          kind: "human_gate",
          depends_on: ["plan"],
          prompt_template: "Approve plan?",
        },
        {
          key: "implement",
          title: "Implement",
          kind: "agent",
          depends_on: ["gate"],
          target_session_id: managedSid,
          prompt_template: "implement-after:{{step.gate}}",
          include_handoff: true,
        },
      ],
    });

    const started = await startWorkflowRun(db, wf.id, {
      input: "build-feature-x",
      initiated_by: WEB_CONSOLE_ID,
    });
    assert.equal(started.workflow_id, wf.id);

    // Wait for step 1 (plan) to finish and step 2 (gate) to pause at waiting_human
    const waitingRun = await waitFor(() => {
      const r = getWorkflowRun(db, started.id);
      return r?.status === "waiting_human" ? r : undefined;
    }, "workflow waiting at human_gate");

    const planStep = waitingRun.steps.find((s) => s.step_key === "plan")!;
    const gateStep = waitingRun.steps.find((s) => s.step_key === "gate")!;
    assert.equal(planStep.status, "done");
    assert.ok((planStep.output ?? "").includes("build-feature-x"));
    assert.equal(gateStep.status, "waiting_human");

    // Approve human gate -> triggers implement step with automatic handoff dossier
    await approveHumanGate(db, gateStep.id, { approved: true, comment: "LGTM ship it" });

    const completedRun = await waitFor(() => {
      const r = getWorkflowRun(db, started.id);
      return r?.status === "completed" ? r : undefined;
    }, "workflow completion");

    const implStep = completedRun.steps.find((s) => s.step_key === "implement")!;
    assert.equal(implStep.status, "done");
    assert.ok((implStep.output ?? "").includes("LGTM ship it"));
    assert.ok((implStep.output ?? "").includes("Use ACP for Antigravity"));

    // Explicit cross-session handoff stores kind='handoff' entry and delivers to target
    const handoff = await handoffContext(db, {
      from_session: WEB_CONSOLE_ID,
      to_session: managedSid,
      room_id: room.id,
      prompt: "Verify final checklist",
    });
    assert.equal(handoff.context_entry.kind, "handoff");
    assert.equal(handoff.delivered, true);
    assert.ok(handoff.message_id);
    const handoffReply = await waitFor(() => {
      const m = getMessage(db, handoff.message_id!);
      return m?.status === "replied" ? m : undefined;
    }, "handoff delivery reply");
    assert.ok((handoffReply.reply ?? "").includes("Verify final checklist"));

    // External session reply also advances workflows via HTTP routes
    const app = Fastify();
    const ctx = createServerContext(db, { dataDir: process.cwd(), port: 0 });
    registerWorkflowRoutes(app, ctx);
    registerContextRoutes(app, ctx);
    await app.ready();
    try {
      const listResp = await app.inject({ method: "GET", url: `/workflows?room_id=${room.id}` });
      assert.equal(listResp.statusCode, 200);
      assert.equal(listResp.json().workflows.length, 1);

      const roomCtxResp = await app.inject({ method: "GET", url: `/chat-rooms/${room.id}/context` });
      assert.equal(roomCtxResp.statusCode, 200);
      assert.ok(roomCtxResp.json().entries.length >= 2);
    } finally {
      await app.close();
    }

    // Sanity check replyAsk directly works without breaking external path
    const extWf = createWorkflow(db, {
      name: "External Step",
      room_id: room.id,
      steps: [
        {
          key: "review",
          title: "Review",
          kind: "agent",
          depends_on: [],
          target_session_id: "ext-reviewer",
          prompt_template: "review this",
        },
      ],
    });
    const extRun = await startWorkflowRun(db, extWf.id, { initiated_by: WEB_CONSOLE_ID });
    const revStep = extRun.steps[0];
    assert.equal(revStep.status, "running");
    assert.ok(revStep.message_id);
    replyAsk(db, revStep.message_id!, "ext-reviewer", "reviewed ok");
  } finally {
    setManagedAntigravityManager(null);
    await manager.shutdown();
    cleanup();
  }
});

test("live event bus replays buffered events after cursor and respects room filter", () => {
  resetLiveEventBusForTest();
  const e1 = publishLiveEvent({ type: "room.message", room_id: 1, payload: { n: 1 } });
  const e2 = publishLiveEvent({ type: "room.message", room_id: 2, payload: { n: 2 } });
  const e3 = publishLiveEvent({ type: "workflow.updated", room_id: 1, payload: { n: 3 } });
  assert.deepEqual(
    replayLiveEventsAfter(e1.id, { room_id: 1 }).map((e) => e.id),
    [e3.id],
  );
  assert.deepEqual(
    replayLiveEventsAfter(0, { room_id: 2 }).map((e) => e.id),
    [e2.id],
  );
});
