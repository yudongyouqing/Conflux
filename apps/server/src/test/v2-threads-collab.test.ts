import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_CONSOLE_ID } from "@conflux/shared";
import { makeDb } from "./helpers.js";
import { createProject } from "../core/projects.js";
import { resolveGitBinary } from "../core/git-worktree.js";
import {
  ThreadManager,
  setThreadManager,
} from "../core/threads/executor.js";
import {
  getThread,
  listPendingThreadApprovals,
  listThreadCheckpoints,
  listThreadRuns,
} from "../core/threads/store.js";
import { publishContext, updateContext } from "../core/context.js";
import { askThread, getMessage, replyMessage } from "../core/messages.js";
import { createRoom, getRoomTask, installRoomOrchestrationHooks, summonRoomAgent } from "../core/rooms.js";
import {
  approveHumanGate,
  createWorkflow,
  getWorkflowRun,
  installWorkflowHooks,
  onWorkflowStepMessageCompleted,
  startWorkflowRun,
} from "../core/workflows.js";
import { ensureMcpThread } from "../mcp/server.js";
import { resetLiveEventBusForTest, publishLiveEvent, replayLiveEventsAfter } from "../core/event-bus.js";
import { saveRuntimeSettings } from "../core/runtime-env.js";

const ACP_SHIM = fileURLToPath(new URL("./managed-acp-shim.cjs", import.meta.url));
const CLAUDE_SHIM = fileURLToPath(new URL("./managed-claude-shim.cjs", import.meta.url));

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val !== undefined) return val;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeGitProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "conflux-v2-collab-git-"));
  const gitBin = resolveGitBinary();
  const run = (args: string[]) =>
    execFileSync(gitBin, args, { cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@local"]);
  writeFileSync(join(dir, "index.ts"), "export const v = 1;\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }),
  };
}

function makeTestManager(db: ReturnType<typeof makeDb>["db"]) {
  const manager = new ThreadManager(db, {
    resolveLaunch: (runtime, spec, opts) => {
      if (runtime === "claude") {
        return {
          executable: CLAUDE_SHIM,
          args: opts?.resumeThreadId ? ["--resume", opts.resumeThreadId] : [],
          cwd: spec.workdir,
          env: { ...process.env },
        };
      }
      return {
        executable: ACP_SHIM,
        args: [],
        cwd: spec.workdir,
        env: { ...process.env },
      };
    },
    rpcOptions: { requestTimeoutMs: 5000 },
  });
  setThreadManager(manager);
  installRoomOrchestrationHooks();
  installWorkflowHooks();
  return manager;
}

test("ThreadManager enforces single-writer dir lock, supports worktree concurrency, multi-chunk ACP, steer, resume & auto approval audit", async () => {
  const { db, cleanup } = makeDb();
  const { dir, cleanup: cleanupGit } = makeGitProject();
  const manager = makeTestManager(db);
  try {
    const proj = createProject(db, { root_path: dir, name: "MainProj" });
    const t1 = await manager.createAndStartThread({
      project_id: proj.id,
      name: "agy-primary",
      runtime: "antigravity",
      approval_mode: "ask",
    });

    // 1. Single-writer directory lock refuses a second non-worktree Agent on same dir.
    await assert.rejects(
      () =>
        manager.createAndStartThread({
          project_id: proj.id,
          name: "agy-conflict",
          runtime: "antigravity",
          use_worktree: false,
        }),
      /目录写锁冲突/,
    );

    // 2. Second agent WITH independent worktree succeeds concurrently!
    const t2 = await manager.createAndStartThread({
      project_id: proj.id,
      name: "agy-isolated",
      runtime: "antigravity",
      approval_mode: "auto",
      use_worktree: true,
    });
    assert.ok(t2.worktree_path && t2.worktree_branch?.startsWith("conflux/"));

    // 3. Multi-chunk streaming assembly + pre-turn invisible Git checkpoint creation.
    const { run: r1 } = await manager.enqueuePrompt(t1.id, { prompt: "stream-chunks" });
    const finished1 = await waitFor(() => {
      const r = listThreadRuns(db, t1.id).find((x) => x.id === r1!.id);
      return r?.state === "completed" ? r : undefined;
    }, "multi-chunk stream reply");
    assert.equal(finished1.final_text, "Alpha Beta Gamma.");
    assert.ok(listThreadCheckpoints(db, t1.id).length >= 1, "pre-turn checkpoint created");

    // 4. Native optionId approval in 'ask' mode on t1.
    const { run: rAsk } = await manager.enqueuePrompt(t1.id, { prompt: "approve:run-tests" });
    const pending = await waitFor(
      () => listPendingThreadApprovals(db, { threadId: t1.id })[0],
      "pending approval on t1",
    );
    const resolved = await manager.resolveApproval(t1.id, pending.id, "accept", {
      optionId: "opt_allow_once",
    });
    assert.equal(resolved.ok, true);
    const doneAsk = await waitFor(() => {
      const r = listThreadRuns(db, t1.id).find((x) => x.id === rAsk!.id);
      return r?.state === "completed" ? r : undefined;
    }, "approval run completed");
    assert.equal(doneAsk.final_text, "perm:selected:opt_allow_once");

    // 5. Per-agent `approval_mode: 'auto'` on t2 auto-approves into auditable `auto_approved` state!
    const { run: rAuto } = await manager.enqueuePrompt(t2.id, { prompt: "approve:auto-cmd" });
    const doneAuto = await waitFor(() => {
      const r = listThreadRuns(db, t2.id).find((x) => x.id === rAuto!.id);
      return r?.state === "completed" ? r : undefined;
    }, "auto-approved run completed");
    assert.equal(doneAuto.final_text, "perm:selected:opt_allow_once");
    const autoRow = db
      .prepare(`SELECT state, decision FROM thread_approvals WHERE run_id = ?`)
      .get(rAuto!.id) as { state: string; decision: string };
    assert.equal(autoRow.state, "auto_approved");
    assert.equal(autoRow.decision, "accept");

    // 6. Active-turn Steer + Stop & Resume preserving provider_thread_id.
    const { run: rSlow } = await manager.enqueuePrompt(t1.id, { prompt: "slow:work" });
    await waitFor(
      () => (listThreadRuns(db, t1.id).find((x) => x.id === rSlow!.id)?.state === "running" ? true : undefined),
      "slow turn running",
    );
    const steerRes = await manager.steer(t1.id, "pivot-fast");
    assert.equal(steerRes.accepted, true);
    const doneSteer = await waitFor(() => {
      const r = listThreadRuns(db, t1.id).find((x) => x.id === rSlow!.id);
      return r?.state === "completed" ? r : undefined;
    }, "steered turn done");
    assert.ok((doneSteer.final_text ?? "").includes("steered:pivot-fast"));

    const savedProviderId = getThread(db, t1.id)!.provider_thread_id;
    const stopped = await manager.stopThread(t1.id);
    assert.equal(stopped.state, "stopped");
    const resumed = await manager.resumeThread(t1.id);
    assert.equal(resumed.state, "idle");
    assert.equal(resumed.provider_thread_id, savedProviderId);
  } finally {
    await manager.shutdown();
    setThreadManager(null);
    cleanup();
    cleanupGit();
  }
});

test("incremental pinned memory preserves prompt prefix, optimistic locking catches conflicts, and Fork & Handoff transfers workdir", async () => {
  const { db, cleanup } = makeDb();
  const { dir, cleanup: cleanupGit } = makeGitProject();
  const manager = makeTestManager(db);
  try {
    const proj = createProject(db, { root_path: dir, name: "MemProj" });
    const tAgy = await manager.createAndStartThread({
      project_id: proj.id,
      name: "agy-planner",
      runtime: "antigravity",
    });

    // Publish pinned decision & verify optimistic version conflict.
    const dec = publishContext(db, {
      thread_id: WEB_CONSOLE_ID,
      project_id: proj.id,
      kind: "decision",
      pinned: true,
      title: "Use TS Fullstack",
      content: "Keep TypeScript end-to-end.",
    });
    assert.equal(dec.version, 1);
    const updated = updateContext(db, dec.id, { content: "Keep TS v2.", expected_version: 1 });
    assert.equal(updated?.version, 2);
    assert.throws(
      () => updateContext(db, dec.id, { content: "stale overwrite", expected_version: 1 }),
      /版本冲突/,
    );

    // Turn 1: pinned memory #1 is appended once and cursor advances.
    const { run: run1 } = await manager.enqueuePrompt(tAgy.id, { prompt: "hello-1" });
    const done1 = await waitFor(() => {
      const r = listThreadRuns(db, tAgy.id).find((x) => x.id === run1!.id);
      return r?.state === "completed" ? r : undefined;
    }, "turn 1 done");
    assert.ok(done1.final_text?.includes("Use TS Fullstack"), "first turn receives incremental pinned memory");
    assert.equal(getThread(db, tAgy.id)?.last_synced_context_id, dec.id);

    // Turn 2: no new pinned memory -> NOT re-appended (prefix clean, zero duplication).
    const { run: run2 } = await manager.enqueuePrompt(tAgy.id, { prompt: "hello-2" });
    const done2 = await waitFor(() => {
      const r = listThreadRuns(db, tAgy.id).find((x) => x.id === run2!.id);
      return r?.state === "completed" ? r : undefined;
    }, "turn 2 done");
    assert.equal(done2.final_text, "acp-echo:hello-2");

    // In-place Fork & Handoff from Antigravity -> Claude on the same project workdir!
    const forked = await manager.forkAndHandoff(tAgy.id, {
      target_runtime: "claude",
      prompt: "Continue implementing the plan",
    });
    assert.equal(forked.source_thread.state, "stopped");
    assert.equal(forked.target_thread.runtime, "claude");
    assert.equal(forked.target_thread.parent_thread_id, tAgy.id);
    assert.equal(forked.target_thread.workdir, tAgy.workdir);
    assert.equal(forked.context_entry.kind, "handoff");

    const claudeDone = await waitFor(() => {
      const r = listThreadRuns(db, forked.target_thread.id).find((x) => x.id === forked.run!.id);
      return r?.state === "completed" ? r : undefined;
    }, "forked claude turn done");
    assert.ok(claudeDone.final_text?.includes("Continue implementing the plan"));
  } finally {
    await manager.shutdown();
    setThreadManager(null);
    cleanup();
    cleanupGit();
  }
});

test("two-way Room sync, autonomous hop/cooldown guardrails, DAG Workflow w/ human_gate + external MCP thread, and live SSE replay", async () => {
  resetLiveEventBusForTest();
  const { db, cleanup } = makeDb();
  const { dir, cleanup: cleanupGit } = makeGitProject();
  const manager = makeTestManager(db);
  try {
    const proj = createProject(db, { root_path: dir, name: "OrchProj" });
    const tAgy = await manager.createAndStartThread({
      project_id: proj.id,
      name: "agy-room-worker",
      runtime: "antigravity",
      approval_mode: "auto",
    });
    // External terminal MCP thread auto-linked to same project.
    const extId = ensureMcpThread(db, {
      id: "ext-claude-term",
      name: "External Claude",
      project_dir: dir,
      runtime: "claude",
    });
    const extThread = getThread(db, extId)!;
    assert.equal(extThread.kind, "external");
    assert.equal(extThread.project_id, proj.id);

    // 1. Two-way Room summon auto-finalizes room_task on managed turn completion.
    const room = createRoom(db, {
      name: "Squad Room",
      project_id: proj.id,
      members: [tAgy.id, extId],
    });
    const summoned = await summonRoomAgent(db, {
      room_id: room.id,
      executor_thread_id: tAgy.id,
      prompt: "summarize module",
    });
    assert.equal(summoned.delivered, true);
    const doneTask = await waitFor(() => {
      const t = getRoomTask(db, summoned.task.id);
      return t?.status === "done" ? t : undefined;
    }, "room task auto-finalized");
    assert.ok(doneTask.summary?.includes("summarize module"));

    // 2. Autonomous loop guardrails (pair cooldown & max hops).
    saveRuntimeSettings(db, { max_autonomous_hops: 2, pair_cooldown_ms: 5000 });
    await askThread(db, { from_thread: tAgy.id, to_thread: extId, question: "hop-1", hop_count: 1 });
    await assert.rejects(
      () => askThread(db, { from_thread: extId, to_thread: tAgy.id, question: "too-fast", hop_count: 2 }),
      /冷却护栏/,
    );
    await assert.rejects(
      () => askThread(db, { from_thread: tAgy.id, to_thread: extId, question: "too-deep", hop_count: 3 }),
      /跳数已达上限/,
    );
    saveRuntimeSettings(db, { max_autonomous_hops: 5, pair_cooldown_ms: 0 });

    // 3. DAG Workflow: rejects cycle, runs managed -> human_gate -> external MCP reply.
    assert.throws(
      () =>
        createWorkflow(db, {
          name: "Cyclic",
          steps: [
            { key: "a", title: "A", kind: "agent", depends_on: ["b"], target_thread_id: tAgy.id, prompt_template: "a" },
            { key: "b", title: "B", kind: "agent", depends_on: ["a"], target_thread_id: tAgy.id, prompt_template: "b" },
          ],
        }),
      /cycle/i,
    );

    const wf = createWorkflow(db, {
      name: "Plan-Gate-Review",
      project_id: proj.id,
      room_id: room.id,
      steps: [
        { key: "plan", title: "Plan", kind: "agent", depends_on: [], target_thread_id: tAgy.id, prompt_template: "plan:{{input}}" },
        { key: "gate", title: "Human Gate", kind: "human_gate", depends_on: ["plan"], prompt_template: "" },
        { key: "ext_review", title: "External Review", kind: "agent", depends_on: ["gate"], target_thread_id: extId, prompt_template: "review:{{step.plan}}", include_handoff: true },
      ],
    });
    const run = await startWorkflowRun(db, wf.id, { input: "v2-launch", initiated_by: WEB_CONSOLE_ID });
    const atGate = await waitFor(() => {
      const cur = getWorkflowRun(db, run.id);
      return cur?.status === "waiting_human" ? cur : undefined;
    }, "workflow paused at human_gate");
    const gateStep = atGate.steps.find((s) => s.step_key === "gate")!;
    const afterGate = await approveHumanGate(db, gateStep.id, { approved: true, comment: "ship it" });
    const extStep = afterGate.steps.find((s) => s.step_key === "ext_review")!;
    assert.equal(extStep.status, "running");
    assert.ok(extStep.message_id);

    // External terminal replies via MCP/HTTP -> auto-completes workflow!
    replyMessage(db, extStep.message_id!, extId, "External review LGTM");
    await onWorkflowStepMessageCompleted(db, extStep.message_id!, {
      ok: true,
      output: "External review LGTM",
    });
    const completedRun = getWorkflowRun(db, run.id)!;
    assert.equal(completedRun.status, "completed");
    assert.equal(getMessage(db, extStep.message_id!)?.reply, "External review LGTM");

    // 4. Live SSE event bus cursor replay & scoping.
    const ev1 = publishLiveEvent({ type: "git.dirty", project_id: proj.id, thread_id: tAgy.id, payload: { a: 1 } });
    const ev2 = publishLiveEvent({ type: "git.dirty", project_id: proj.id + 99, payload: { a: 2 } });
    const replayed = replayLiveEventsAfter(ev1.id - 1, { project_id: proj.id });
    assert.ok(replayed.some((e) => e.id === ev1.id));
    assert.ok(!replayed.some((e) => e.id === ev2.id));
  } finally {
    await manager.shutdown();
    setThreadManager(null);
    cleanup();
    cleanupGit();
  }
});
