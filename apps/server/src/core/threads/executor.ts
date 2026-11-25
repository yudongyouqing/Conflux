import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type {
  AgentThread,
  ApprovalMode,
  ForkHandoffResult,
  ManagedDeliveryMode,
  RuntimeId,
  ThreadDetailResponse,
  ThreadRun,
} from "@conflux/shared";
import { nowIso, type DB } from "../db.js";
import { logger } from "../../log.js";
import { spawnAppServer, type AppServerProcess } from "../managed-codex/process.js";
import { isApprovalDecision, type ApprovalResponseExtra } from "../managed-codex/approvals.js";
import { mergeFinalText } from "../managed-codex/events.js";
import type { RpcHandlers, RpcOptions } from "../managed-codex/rpc.js";
import type { ManagedLaunchConfig, ManagedLaunchOptions, RuntimeAdapter } from "../managed/adapter.js";
import { codexAdapter } from "../managed-codex/adapter.js";
import { claudeAdapter } from "../managed-claude/adapter.js";
import { acpAdapter, antigravityAdapter } from "../managed-acp/adapter.js";
import type { ThreadLaunchSpec } from "../runtime-env.js";
import { collectIncrementalPinnedMemory, publishContext } from "../context.js";
import { ensureProjectForDir, getProject } from "../projects.js";
import {
  cleanupWorktree,
  createInvisibleCheckpoint,
  createWorktree,
  deleteThreadCheckpoints,
  getCurrentBranch,
  isGitRepo,
  rollbackToCheckpoint,
} from "../git-worktree.js";
import { publishLiveEvent } from "../event-bus.js";
import {
  appendThreadEvent,
  assertDirectoryWritable,
  claimNextQueuedRun,
  createThreadRun,
  deleteThreadRow,
  expireThreadApprovals,
  getThread,
  getThreadApproval,
  getThreadCheckpoint,
  heartbeatThread,
  insertThread,
  isValidRuntime,
  listPendingThreadApprovals,
  listQueuedRunIds,
  listThreadCheckpoints,
  listThreadRuns,
  listThreads,
  recordThreadApproval,
  recordThreadCheckpoint,
  resolveThreadApprovalRow,
  updateThread,
  updateThreadRun,
} from "./store.js";

export type TurnFinalizedListener = (info: {
  db: DB;
  threadId: string;
  runId: number;
  messageId: number | null;
  roomId: number | null;
  state: "completed" | "failed" | "interrupted";
  finalText: string | null;
  errorCode: string | null;
}) => void;

const turnFinalizedListeners = new Set<TurnFinalizedListener>();

export function onThreadTurnFinalized(fn: TurnFinalizedListener): () => void {
  turnFinalizedListeners.add(fn);
  return () => {
    turnFinalizedListeners.delete(fn);
  };
}

interface RawFrame {
  kind: "notification" | "server_request";
  id?: number | string;
  method: string;
  params: unknown;
}

interface LiveThreadProcess {
  threadId: string;
  runtime: RuntimeId;
  adapter: RuntimeAdapter;
  ownerToken: string;
  providerThreadId: string;
  proc: AppServerProcess;
  activeTurn: { runId: number; turnId: string } | null;
  submitting: boolean;
  submittingRunId: number | null;
  deferred: RawFrame[];
  agentTexts: string[];
  liveApprovals: Map<number, number | string>;
}

export interface ThreadManagerOptions {
  adapters?: Partial<Record<RuntimeId, RuntimeAdapter>>;
  resolveLaunch?: (
    runtime: RuntimeId,
    spec: ThreadLaunchSpec,
    opts?: ManagedLaunchOptions,
  ) => ManagedLaunchConfig;
  rpcOptions?: RpcOptions;
}

function defaultAdapters(): Record<RuntimeId, RuntimeAdapter> {
  return {
    codex: codexAdapter,
    claude: claudeAdapter,
    antigravity: antigravityAdapter,
    acp: acpAdapter,
  };
}

function toLaunchSpec(thread: AgentThread): ThreadLaunchSpec {
  return {
    id: thread.id,
    name: thread.name,
    runtime: thread.runtime,
    workdir: thread.workdir,
    model: thread.model,
    instructions: thread.instructions,
    extra_env: thread.extra_env,
  };
}

function replyTextFor(
  state: "completed" | "failed" | "interrupted",
  finalText: string | null,
  errorCode: string | null,
): string {
  if (state === "completed") return finalText?.trim() || "（任务完成，无文本输出）";
  if (state === "interrupted") return "任务被中断";
  return errorCode ? `任务失败：${errorCode}` : "任务执行失败";
}

export class ThreadManager {
  readonly db: DB;
  private readonly adapters: Record<RuntimeId, RuntimeAdapter>;
  private readonly opts: ThreadManagerOptions;
  private readonly live = new Map<string, LiveThreadProcess>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(db: DB, opts: ThreadManagerOptions = {}) {
    this.db = db;
    this.opts = opts;
    this.adapters = {
      ...defaultAdapters(),
      ...(opts.adapters ?? {}),
    };
  }

  getLiveThreadIds(): Set<string> {
    return new Set(this.live.keys());
  }

  isLive(threadId: string): boolean {
    return this.live.has(threadId);
  }

  getAdapter(runtime: RuntimeId): RuntimeAdapter {
    const adapter = this.adapters[runtime];
    if (!adapter) throw Object.assign(new Error(`unsupported runtime: ${runtime}`), { statusCode: 400 });
    return adapter;
  }

  decorateThread(thread: AgentThread): AgentThread {
    const adapter = this.adapters[thread.runtime];
    return {
      ...thread,
      live: thread.kind === "managed" ? this.live.has(thread.id) : thread.state !== "stopped",
      supports_steer: thread.kind === "managed" && typeof adapter?.steerTurn === "function",
    };
  }

  listDecoratedThreads(opts: { project_id?: number; kind?: "managed" | "external" } = {}): AgentThread[] {
    return listThreads(this.db, opts).map((t) => this.decorateThread(t));
  }

  getThreadDetail(threadId: string): ThreadDetailResponse | null {
    const thread = getThread(this.db, threadId);
    if (!thread) return null;
    return {
      thread: this.decorateThread(thread),
      runs: listThreadRuns(this.db, threadId, 30),
      pending_approvals: listPendingThreadApprovals(this.db, { threadId }),
      checkpoints: listThreadCheckpoints(this.db, threadId, 30),
      queued_run_ids: listQueuedRunIds(this.db, threadId),
    };
  }

  /**
   * One-step zero-ceremony Agent creation: optional isolated git worktree,
   * strict single-writer directory lock for non-worktree dirs, insert `agent_threads`,
   * spawn native child process with Conflux MCP injected, and publish live event.
   */
  async createAndStartThread(input: {
    project_id?: number | null;
    workdir?: string;
    name?: string;
    runtime: RuntimeId;
    model?: string | null;
    instructions?: string | null;
    extra_env?: string | null;
    approval_mode?: ApprovalMode;
    use_worktree?: boolean;
    parent_thread_id?: string | null;
    initial_prompt?: string | null;
  }): Promise<AgentThread> {
    if (!isValidRuntime(input.runtime)) {
      throw Object.assign(new Error(`unsupported runtime: ${input.runtime}`), { statusCode: 400 });
    }
    let project = input.project_id ? getProject(this.db, input.project_id) : null;
    if (input.project_id && !project) {
      throw Object.assign(new Error("project not found"), { statusCode: 404 });
    }
    const baseDir = resolve(input.workdir?.trim() || project?.root_path || process.cwd());
    if (!project) {
      project = ensureProjectForDir(this.db, baseDir);
    }

    const name =
      input.name?.trim() || `${input.runtime}-${basename(baseDir)}-${randomUUID().slice(0, 4)}`;

    let workdir = baseDir;
    let worktreePath: string | null = null;
    let worktreeBranch: string | null = null;
    let baseBranch: string | null = isGitRepo(baseDir) ? getCurrentBranch(baseDir) : null;

    if (input.use_worktree) {
      const wt = createWorktree(project?.root_path ?? baseDir, name);
      workdir = wt.worktreePath;
      worktreePath = wt.worktreePath;
      worktreeBranch = wt.branch;
      baseBranch = wt.baseBranch;
    } else {
      assertDirectoryWritable(this.db, workdir, { liveThreadIds: this.getLiveThreadIds() });
    }

    const thread = insertThread(this.db, {
      project_id: project?.id ?? null,
      name,
      kind: "managed",
      runtime: input.runtime,
      state: "idle",
      approval_mode: input.approval_mode ?? "ask",
      workdir,
      worktree_path: worktreePath,
      worktree_branch: worktreeBranch,
      base_branch: baseBranch,
      model: input.model ?? null,
      instructions: input.instructions ?? null,
      extra_env: input.extra_env ?? null,
      parent_thread_id: input.parent_thread_id ?? null,
    });

    try {
      await this.spawnAndAttach(thread, false);
    } catch (err) {
      updateThread(this.db, thread.id, { state: "error" });
      if (worktreePath && project?.root_path) {
        cleanupWorktree(project.root_path, worktreePath, worktreeBranch, true);
      }
      throw err;
    }

    const liveThread = this.decorateThread(getThread(this.db, thread.id)!);
    publishLiveEvent({
      type: "thread.updated",
      project_id: liveThread.project_id,
      thread_id: liveThread.id,
      payload: { action: "started", thread: liveThread },
    });

    if (input.initial_prompt?.trim()) {
      await this.enqueuePrompt(liveThread.id, { prompt: input.initial_prompt.trim() });
    }
    return this.decorateThread(getThread(this.db, thread.id)!);
  }

  /**
   * Stop a managed thread's child process while preserving full history,
   * checkpoints, worktree, and `provider_thread_id` for one-click resume.
   */
  async stopThread(threadId: string): Promise<AgentThread> {
    const thread = getThread(this.db, threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    const live = this.live.get(threadId);
    if (live) {
      this.live.delete(threadId);
      const inFlightId = live.activeTurn?.runId ?? live.submittingRunId;
      if (inFlightId !== null) {
        updateThreadRun(this.db, inFlightId, {
          state: "interrupted",
          error_code: "stopped by user",
        });
      }
      expireThreadApprovals(this.db, threadId);
      live.activeTurn = null;
      live.submitting = false;
      live.submittingRunId = null;
      live.liveApprovals.clear();
      live.proc.kill();
      await live.proc.exited;
    }
    const updated = this.decorateThread(
      updateThread(this.db, threadId, {
        state: "stopped",
        active_turn_id: null,
        pid: null,
      })!,
    );
    publishLiveEvent({
      type: "thread.updated",
      project_id: updated.project_id,
      thread_id: updated.id,
      payload: { action: "stopped", thread: updated },
    });
    return updated;
  }

  /**
   * Resume a stopped managed thread on a fresh child process, rejoining its saved
   * `provider_thread_id` while enforcing the single-writer directory lock.
   */
  async resumeThread(threadId: string): Promise<AgentThread> {
    const thread = getThread(this.db, threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    if (thread.kind !== "managed") {
      throw Object.assign(new Error("外部终端会话无法由 Conflux 直接唤醒"), { statusCode: 400 });
    }
    if (this.live.has(threadId)) {
      return this.decorateThread(thread);
    }
    if (!thread.worktree_path) {
      assertDirectoryWritable(this.db, thread.workdir, {
        excludeThreadId: thread.id,
        liveThreadIds: this.getLiveThreadIds(),
      });
    }
    await this.spawnAndAttach(thread, Boolean(thread.provider_thread_id));
    await this.pump(threadId);
    const updated = this.decorateThread(getThread(this.db, threadId)!);
    publishLiveEvent({
      type: "thread.updated",
      project_id: updated.project_id,
      thread_id: updated.id,
      payload: { action: "resumed", thread: updated },
    });
    return updated;
  }

  /**
   * Same-engine / same-series model switch without breaking context prefixes:
   * uses native live `setModel` when supported (ACP), otherwise transparently
   * stops & resumes on the exact same `provider_thread_id` with the new model.
   */
  async switchModel(threadId: string, model: string): Promise<{ thread: AgentThread; hotSwitched: boolean }> {
    const nextModel = model.trim();
    if (!nextModel) throw Object.assign(new Error("model is required"), { statusCode: 400 });
    const thread = getThread(this.db, threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    if (thread.kind !== "managed") {
      throw Object.assign(new Error("外部终端会话不支持切换模型"), { statusCode: 400 });
    }
    const live = this.live.get(threadId);
    if (live?.activeTurn || live?.submitting) {
      throw Object.assign(new Error("当前轮次执行中，请等待完成或中断后再切换模型"), {
        statusCode: 409,
      });
    }

    updateThread(this.db, threadId, { model: nextModel });
    let hotSwitched = false;
    if (live) {
      if (live.adapter.setModel) {
        try {
          hotSwitched = await live.adapter.setModel(live.proc.conn, live.providerThreadId, nextModel);
        } catch {
          hotSwitched = false;
        }
      }
      if (!hotSwitched) {
        await this.stopThread(threadId);
        await this.resumeThread(threadId);
      }
    }

    const updated = this.decorateThread(getThread(this.db, threadId)!);
    appendThreadEvent(this.db, {
      threadId,
      type: "status",
      payload: { phase: "model_switched", model: nextModel, hotSwitched },
    });
    publishLiveEvent({
      type: "thread.updated",
      project_id: updated.project_id,
      thread_id: updated.id,
      payload: { action: "model_switched", thread: updated },
    });
    return { thread: updated, hotSwitched };
  }

  /** Toggle per-agent approval mode (`ask` | `auto`) live. */
  setApprovalMode(threadId: string, mode: ApprovalMode): AgentThread {
    const thread = getThread(this.db, threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    const next: ApprovalMode = mode === "auto" ? "auto" : "ask";
    const updated = this.decorateThread(updateThread(this.db, threadId, { approval_mode: next })!);
    publishLiveEvent({
      type: "thread.updated",
      project_id: updated.project_id,
      thread_id: updated.id,
      payload: { action: "approval_mode_updated", thread: updated },
    });
    return updated;
  }

  /**
   * Deliver a user or room/workflow prompt to a managed thread with delivery mode:
   *  - `steer`: inject into active turn if running (falls back to queue if idle)
   *  - `interrupt`: cancel active turn then enqueue the new prompt
   *  - `queue` (default): FIFO queue + immediate pump
   */
  async enqueuePrompt(
    threadId: string,
    input: {
      prompt: string;
      messageId?: number | null;
      roomId?: number | null;
      deliveryMode?: ManagedDeliveryMode;
      senderLabel?: string;
    },
  ): Promise<{ run: ThreadRun | null; steered?: boolean }> {
    const thread = getThread(this.db, threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    if (thread.kind !== "managed") {
      throw Object.assign(new Error("外部终端会话由外部 CLI 自主消费消息"), { statusCode: 400 });
    }
    if (!this.live.has(threadId)) {
      await this.resumeThread(threadId);
    }

    const mode = input.deliveryMode ?? "queue";
    const live = this.live.get(threadId);
    if (mode === "steer" && live?.activeTurn) {
      const steerRes = await this.steer(threadId, input.prompt);
      if (steerRes.accepted) return { run: null, steered: true };
    }
    if (mode === "interrupt" && live?.activeTurn) {
      await this.interrupt(threadId);
    }

    const run = createThreadRun(this.db, {
      threadId,
      prompt: input.prompt,
      messageId: input.messageId ?? null,
      roomId: input.roomId ?? null,
    });
    const ev = appendThreadEvent(this.db, {
      threadId,
      runId: run.id,
      type: "user",
      payload: {
        text: input.prompt,
        ...(input.roomId ? { roomId: input.roomId } : {}),
        ...(input.senderLabel ? { sender: input.senderLabel } : {}),
      },
    });
    publishLiveEvent({
      type: "thread.event",
      project_id: thread.project_id,
      thread_id: threadId,
      room_id: input.roomId ?? null,
      payload: { event: ev },
    });

    await this.pump(threadId);
    return { run };
  }

  async steer(threadId: string, text: string): Promise<{ accepted: boolean; reason?: string }> {
    const live = this.live.get(threadId);
    if (!live) throw Object.assign(new Error("thread is not running"), { statusCode: 409 });
    if (!live.activeTurn) return { accepted: false, reason: "no active turn" };
    if (!live.adapter.steerTurn) {
      return { accepted: false, reason: `${live.runtime} does not support live steering` };
    }
    const res = await live.adapter.steerTurn(
      live.proc.conn,
      live.providerThreadId,
      live.activeTurn.turnId,
      { text },
    );
    if (res.accepted) {
      const ev = appendThreadEvent(this.db, {
        threadId,
        runId: live.activeTurn.runId,
        type: "user",
        payload: { text, phase: "steered" },
      });
      publishLiveEvent({
        type: "thread.event",
        thread_id: threadId,
        payload: { event: ev },
      });
    }
    return res;
  }

  async interrupt(threadId: string): Promise<{ accepted: boolean; reason?: string }> {
    const live = this.live.get(threadId);
    if (!live) throw Object.assign(new Error("thread is not running"), { statusCode: 409 });
    if (!live.activeTurn) return { accepted: false, reason: "no active turn" };
    await live.adapter.interrupt(live.proc.conn, live.providerThreadId, live.activeTurn.turnId);
    return { accepted: true };
  }

  async resolveApproval(
    threadId: string,
    approvalId: number,
    decision: unknown,
    extra?: ApprovalResponseExtra,
  ): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
    if (!isApprovalDecision(decision)) {
      return { ok: false, status: 400, reason: "decision must be accept | decline | cancel" };
    }
    const live = this.live.get(threadId);
    if (!live) return { ok: false, status: 409, reason: "thread is not live" };
    const existing = getThreadApproval(this.db, approvalId);
    if (!existing || existing.thread_id !== threadId) {
      return { ok: false, status: 404, reason: "approval not found" };
    }
    if (existing.state !== "pending") {
      return { ok: false, status: 409, reason: `approval already ${existing.state}` };
    }
    const rpcId = live.liveApprovals.get(approvalId);
    if (rpcId === undefined) {
      return { ok: false, status: 409, reason: "approval is not answerable on this connection" };
    }

    const wireResponse = live.adapter.formatApprovalResponse
      ? live.adapter.formatApprovalResponse(decision, extra)
      : {
          decision,
          ...(extra?.optionId ? { optionId: extra.optionId } : {}),
          ...(extra?.answers ? { answers: extra.answers } : {}),
        };
    try {
      live.adapter.respond(live.proc.conn, rpcId, wireResponse);
    } catch {
      return { ok: false, status: 409, reason: "thread connection closed" };
    }

    const outcome = resolveThreadApprovalRow(this.db, { approvalId, decision, extra });
    if (!outcome.ok) return outcome;
    live.liveApprovals.delete(approvalId);

    const stillPending = listPendingThreadApprovals(this.db, { threadId });
    if (stillPending.length === 0) {
      updateThreadRun(this.db, existing.run_id, { state: "running" }, ["waiting_approval"]);
      updateThread(this.db, threadId, { state: "running" });
    }

    const thread = getThread(this.db, threadId);
    const ev = appendThreadEvent(this.db, {
      threadId,
      runId: existing.run_id,
      type: "approval",
      payload: {
        phase: "resolved",
        approvalId,
        decision,
        ...(extra?.optionId ? { optionId: extra.optionId } : {}),
        ...(extra?.answers ? { answers: extra.answers } : {}),
      },
    });
    publishLiveEvent({
      type: "thread.event",
      project_id: thread?.project_id ?? null,
      thread_id: threadId,
      room_id: existing.room_id ?? null,
      payload: { event: ev },
    });
    publishLiveEvent({
      type: "approval.updated",
      project_id: thread?.project_id ?? null,
      thread_id: threadId,
      room_id: existing.room_id ?? null,
      payload: { action: "resolved", approval: outcome.row },
    });
    if (thread) {
      publishLiveEvent({
        type: "thread.updated",
        project_id: thread.project_id,
        thread_id: threadId,
        payload: { action: "approval_resolved", thread: this.decorateThread(thread) },
      });
    }
    return { ok: true };
  }

  /** Roll back a thread's working directory to a previously captured invisible Git checkpoint. */
  async rollbackCheckpoint(threadId: string, checkpointId: number): Promise<{ ok: true; checkpoint_id: number }> {
    const thread = getThread(this.db, threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    const live = this.live.get(threadId);
    if (live?.activeTurn || live?.submitting) {
      throw Object.assign(new Error("当前轮次正在执行中，请先等待完成或中断后再回滚快照"), {
        statusCode: 409,
      });
    }
    const cp = getThreadCheckpoint(this.db, checkpointId);
    if (!cp || cp.thread_id !== threadId) {
      throw Object.assign(new Error("checkpoint not found"), { statusCode: 404 });
    }
    rollbackToCheckpoint(thread.workdir, cp.ref_name);
    const ev = appendThreadEvent(this.db, {
      threadId,
      runId: cp.run_id,
      type: "status",
      payload: { phase: "checkpoint_restored", checkpointId: cp.id, refName: cp.ref_name },
    });
    publishLiveEvent({
      type: "thread.event",
      project_id: thread.project_id,
      thread_id: threadId,
      payload: { event: ev },
    });
    publishLiveEvent({
      type: "git.dirty",
      project_id: thread.project_id,
      thread_id: threadId,
      payload: { reason: "checkpoint_restored", checkpointId: cp.id },
    });
    return { ok: true, checkpoint_id: cp.id };
  }

  /**
   * In-place Fork & Handoff: stop and archive the source thread, package its
   * recent outputs + pinned project/room memories into a `handoff` context entry,
   * and launch a fresh Agent Thread on the target runtime inheriting the exact
   * same workdir / worktree so work continues without corrupting heterogeneous caches.
   */
  async forkAndHandoff(
    sourceThreadId: string,
    input: {
      target_runtime: RuntimeId;
      model?: string | null;
      name?: string;
      prompt?: string;
      approval_mode?: ApprovalMode;
      summary_override?: string;
    },
  ): Promise<ForkHandoffResult> {
    if (!isValidRuntime(input.target_runtime)) {
      throw Object.assign(new Error(`unsupported runtime: ${input.target_runtime}`), { statusCode: 400 });
    }
    const source = getThread(this.db, sourceThreadId);
    if (!source) throw Object.assign(new Error("source thread not found"), { statusCode: 404 });

    // Archive source thread first so it releases the single-writer lock on the workdir.
    if (this.live.has(sourceThreadId)) {
      await this.stopThread(sourceThreadId);
    }

    const recentRuns = listThreadRuns(this.db, sourceThreadId, 8).reverse();
    const runBlocks = recentRuns
      .filter((r) => r.final_text || r.prompt)
      .map(
        (r, i) =>
          `### 轮次 ${i + 1} (${r.state})\n- 提问：${r.prompt.slice(0, 400)}\n- 产出：${(r.final_text ?? r.error_code ?? "").slice(0, 1000)}`,
      );
    const pinnedRows = this.db
      .prepare(
        `SELECT title, kind, content FROM context_entries
         WHERE pinned = 1 AND (project_id = ? OR thread_id = ?)
         ORDER BY id DESC LIMIT 12`,
      )
      .all(source.project_id ?? -1, source.id) as Array<{
      title: string;
      kind: string;
      content: string;
    }>;

    const summary =
      input.summary_override?.trim() ||
      [
        `# 原地接力交接包：${source.name} (${source.runtime}) → ${input.target_runtime}`,
        `- 工作目录：${source.workdir}`,
        ...(source.worktree_branch ? [`- Worktree 分支：${source.worktree_branch}`] : []),
        ...(pinnedRows.length > 0
          ? [
              `\n## 置顶共享记忆`,
              ...pinnedRows.map((p) => `- [${p.kind}] **${p.title}**：${p.content.slice(0, 400)}`),
            ]
          : []),
        ...(runBlocks.length > 0 ? [`\n## 前序关键进展`, ...runBlocks] : []),
      ].join("\n");

    const contextEntry = publishContext(this.db, {
      thread_id: source.id,
      project_id: source.project_id,
      room_id: source.room_ids?.[0] ?? null,
      kind: "handoff",
      pinned: false,
      title: `原地接力：${source.name} (${source.runtime} → ${input.target_runtime})`,
      content: summary,
      tags: ["fork-handoff", `from:${source.runtime}`, `to:${input.target_runtime}`],
    });

    // Inherit workdir & worktree metadata onto the newly forked thread.
    const nextName = input.name?.trim() || `${source.name} → ${input.target_runtime}`;
    const forked = insertThread(this.db, {
      project_id: source.project_id,
      name: nextName,
      kind: "managed",
      runtime: input.target_runtime,
      state: "idle",
      approval_mode: input.approval_mode ?? source.approval_mode,
      workdir: source.workdir,
      worktree_path: source.worktree_path,
      worktree_branch: source.worktree_branch,
      base_branch: source.base_branch,
      model: input.model ?? null,
      instructions: source.instructions,
      extra_env: source.extra_env,
      parent_thread_id: source.id,
      last_synced_context_id: contextEntry.id,
    });

    // Detach worktree ownership from the archived source thread so cleanup belongs to the successor.
    if (source.worktree_path) {
      updateThread(this.db, source.id, {
        worktree_path: null,
        worktree_branch: null,
      });
    }

    await this.spawnAndAttach(forked, false);

    const handoffPrompt = [
      `[原地接力 #${contextEntry.id}] 你正在同一工作区接手前序 Agent「${source.name} (${source.runtime})」的任务。`,
      input.prompt?.trim() ? `\n**接下来需要你完成**：\n${input.prompt.trim()}` : "",
      `\n---\n${summary}`,
    ]
      .filter(Boolean)
      .join("\n");

    const { run } = await this.enqueuePrompt(forked.id, { prompt: handoffPrompt });
    const updatedSource = this.decorateThread(getThread(this.db, source.id)!);
    const updatedTarget = this.decorateThread(getThread(this.db, forked.id)!);

    publishLiveEvent({
      type: "thread.updated",
      project_id: updatedTarget.project_id,
      thread_id: updatedTarget.id,
      payload: { action: "forked", source_thread_id: updatedSource.id, thread: updatedTarget },
    });

    return {
      source_thread: updatedSource,
      target_thread: updatedTarget,
      context_entry: contextEntry,
      run,
      summary_chars: summary.length,
    };
  }

  /** Delete a thread, stop any child process, recycle invisible checkpoints, and optionally remove worktree. */
  async deleteThread(
    threadId: string,
    opts: { removeWorktree?: boolean } = {},
  ): Promise<boolean> {
    const thread = getThread(this.db, threadId);
    if (!thread) return false;
    if (this.live.has(threadId)) {
      await this.stopThread(threadId);
    }
    deleteThreadCheckpoints(thread.workdir, threadId);
    if (opts.removeWorktree && thread.worktree_path) {
      const project = thread.project_id ? getProject(this.db, thread.project_id) : null;
      if (project?.root_path) {
        cleanupWorktree(project.root_path, thread.worktree_path, thread.worktree_branch, true);
      }
    }
    const deleted = deleteThreadRow(this.db, threadId);
    if (deleted) {
      publishLiveEvent({
        type: "thread.updated",
        project_id: thread.project_id,
        thread_id: threadId,
        payload: { action: "deleted", thread_id: threadId },
      });
    }
    return deleted;
  }

  /** Clean up worktree after ensuring thread is stopped. */
  async cleanupThreadWorktree(threadId: string): Promise<AgentThread> {
    const thread = getThread(this.db, threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    if (!thread.worktree_path) {
      throw Object.assign(new Error("该 Agent 未绑定独立 Worktree"), { statusCode: 400 });
    }
    if (this.live.has(threadId)) {
      await this.stopThread(threadId);
    }
    deleteThreadCheckpoints(thread.workdir, threadId);
    const project = thread.project_id ? getProject(this.db, thread.project_id) : null;
    if (!project) {
      throw Object.assign(new Error("找不到所属项目，无法清理 Worktree"), { statusCode: 400 });
    }
    cleanupWorktree(project.root_path, thread.worktree_path, thread.worktree_branch, true);
    const updated = this.decorateThread(
      updateThread(this.db, threadId, {
        workdir: project.root_path,
        worktree_path: null,
        worktree_branch: null,
      })!,
    );
    publishLiveEvent({
      type: "thread.updated",
      project_id: updated.project_id,
      thread_id: updated.id,
      payload: { action: "worktree_cleaned", thread: updated },
    });
    return updated;
  }

  startQueuePolling(intervalMs = 2000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.db.open) return;
      for (const [threadId, live] of this.live) {
        try {
          heartbeatThread(this.db, threadId);
          if (!live.activeTurn && !live.submitting) {
            void this.pump(threadId);
          }
        } catch {
          // ignore transient lock
        }
      }
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  stopQueuePolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopQueuePolling();
    const active = [...this.live.values()];
    this.live.clear();
    for (const live of active) {
      if (this.db.open) {
        expireThreadApprovals(this.db, live.threadId);
        updateThread(this.db, live.threadId, { state: "stopped", active_turn_id: null, pid: null });
      }
      live.proc.kill();
    }
    await Promise.all(active.map((l) => l.proc.exited));
  }

  // ---- Internal lifecycle & protocol pump ----

  private makeRouter(): { router: { live: LiveThreadProcess | null }; handlers: RpcHandlers } {
    const router: { live: LiveThreadProcess | null } = { live: null };
    const handlers: RpcHandlers = {
      onNotification: (method, params) => {
        const live = router.live;
        if (!live) return;
        if (live.submitting) {
          live.deferred.push({ kind: "notification", method, params });
          return;
        }
        this.dispatchFrame(live, { kind: "notification", method, params });
      },
      onServerRequest: (id, method, params) => {
        const live = router.live;
        if (!live) return;
        if (live.submitting) {
          live.deferred.push({ kind: "server_request", id, method, params });
          return;
        }
        this.dispatchFrame(live, { kind: "server_request", id, method, params });
      },
      onProtocolError: (message) => {
        const live = router.live;
        if (!live || !this.db.open) return;
        appendThreadEvent(this.db, {
          threadId: live.threadId,
          runId: live.activeTurn?.runId ?? null,
          type: "error",
          payload: { phase: "protocol", message },
        });
      },
    };
    return { router, handlers };
  }

  private async spawnAndAttach(thread: AgentThread, isResume: boolean): Promise<void> {
    const adapter = this.getAdapter(thread.runtime);
    const spec = toLaunchSpec(thread);
    const launchOpts: ManagedLaunchOptions =
      isResume && thread.provider_thread_id ? { resumeThreadId: thread.provider_thread_id } : {};
    const launch = this.opts.resolveLaunch
      ? this.opts.resolveLaunch(thread.runtime, spec, launchOpts)
      : adapter.defaultLaunch(this.db, spec, launchOpts);

    const { router, handlers } = this.makeRouter();
    const proc = spawnAppServer({
      executable: launch.executable,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      handlers,
      rpcOptions: this.opts.rpcOptions ?? { requestTimeoutMs: 30_000 },
      createConnection: adapter.createConnection,
    });

    const ownerToken = randomUUID();
    const live: LiveThreadProcess = {
      threadId: thread.id,
      runtime: thread.runtime,
      adapter,
      ownerToken,
      providerThreadId: thread.provider_thread_id ?? "",
      proc,
      activeTurn: null,
      submitting: false,
      submittingRunId: null,
      deferred: [],
      agentTexts: [],
      liveApprovals: new Map(),
    };

    try {
      await adapter.initialize(proc.conn);
      if (isResume && thread.provider_thread_id) {
        const resumed = await adapter.resumeThread(proc.conn, spec, thread.provider_thread_id, {
          db: this.db,
          threadId: thread.id,
        });
        live.providerThreadId = resumed.threadId;
      } else {
        live.providerThreadId = await adapter.startThread(proc.conn, spec, thread.workdir, {
          db: this.db,
          threadId: thread.id,
        });
      }

      updateThread(this.db, thread.id, {
        state: "idle",
        provider_thread_id: live.providerThreadId,
        owner_token: ownerToken,
        active_turn_id: null,
        pid: proc.child.pid ?? null,
        last_seen_at: nowIso(),
      });

      router.live = live;
      this.live.set(thread.id, live);
      void proc.exited.then(() => {
        if (this.live.get(thread.id) === live) {
          this.handleChildDeath(live);
        }
      });
      logger.info(
        { threadId: thread.id, runtime: thread.runtime, providerThreadId: live.providerThreadId },
        "v2 agent thread live",
      );
    } catch (err) {
      this.live.delete(thread.id);
      proc.kill();
      throw err;
    }
  }

  private async pump(threadId: string): Promise<void> {
    const live = this.live.get(threadId);
    if (!live || live.activeTurn || live.submitting) return;
    const claimed = claimNextQueuedRun(this.db, threadId);
    if (!claimed) return;

    const thread = getThread(this.db, threadId);
    if (!thread) return;

    // 1. Pre-turn invisible Git checkpoint (zero pollution to staging/log/stash).
    const cpSnap = createInvisibleCheckpoint(thread.workdir, threadId, claimed.id);
    if (cpSnap) {
      const cpRow = recordThreadCheckpoint(this.db, {
        threadId,
        runId: claimed.id,
        refName: cpSnap.refName,
        treeSha: cpSnap.treeSha,
        commitSha: cpSnap.commitSha,
        summary: claimed.prompt.slice(0, 120),
      });
      updateThreadRun(this.db, claimed.id, { checkpoint_id: cpRow.id });
      const ev = appendThreadEvent(this.db, {
        threadId,
        runId: claimed.id,
        type: "status",
        payload: { phase: "checkpoint", checkpointId: cpRow.id, refName: cpRow.ref_name },
      });
      publishLiveEvent({
        type: "thread.event",
        project_id: thread.project_id,
        thread_id: threadId,
        payload: { event: ev },
      });
    }

    // 2. Prompt-Cache-friendly incremental pinned memory append.
    const inc = collectIncrementalPinnedMemory(this.db, {
      projectId: thread.project_id,
      roomId: claimed.room_id,
      afterId: thread.last_synced_context_id,
    });
    const effectivePrompt = inc.suffix ? `${claimed.prompt}${inc.suffix}` : claimed.prompt;
    if (inc.count > 0 && inc.maxId > thread.last_synced_context_id) {
      updateThread(this.db, threadId, { last_synced_context_id: inc.maxId });
    }

    live.submitting = true;
    live.submittingRunId = claimed.id;
    live.agentTexts = [];
    live.deferred = [];

    try {
      const turnId = await live.adapter.startTurn(live.proc.conn, live.providerThreadId, {
        text: effectivePrompt,
        clientMessageId: claimed.id,
      });
      live.submitting = false;
      live.submittingRunId = null;
      live.activeTurn = { runId: claimed.id, turnId };
      updateThreadRun(this.db, claimed.id, { state: "running", turn_id: turnId }, ["submitting"]);
      updateThread(this.db, threadId, { state: "running", active_turn_id: turnId });
      publishLiveEvent({
        type: "thread.updated",
        project_id: thread.project_id,
        thread_id: threadId,
        room_id: claimed.room_id,
        payload: { action: "turn_started", thread: this.decorateThread(getThread(this.db, threadId)!) },
      });
      this.flushDeferred(live);
    } catch (err) {
      live.submitting = false;
      live.submittingRunId = null;
      live.deferred = [];
      const message = err instanceof Error ? err.message : String(err);
      updateThreadRun(this.db, claimed.id, { state: "failed", error_code: message.slice(0, 500) });
      updateThread(this.db, threadId, { state: "idle", active_turn_id: null });
      appendThreadEvent(this.db, {
        threadId,
        runId: claimed.id,
        type: "error",
        payload: { phase: "submit_failed", error: message.slice(0, 500) },
      });
      this.notifyFinalized(claimed, "failed", null, message.slice(0, 500));
      await this.pump(threadId);
    }
  }

  private dispatchFrame(live: LiveThreadProcess, frame: RawFrame): void {
    try {
      if (frame.kind === "notification") {
        this.handleNotification(live, frame.method, frame.params);
      } else {
        this.handleServerRequest(live, frame.id!, frame.method, frame.params);
      }
    } catch (err) {
      logger.error({ threadId: live.threadId, err }, "v2 thread frame handler error");
    }
  }

  private flushDeferred(live: LiveThreadProcess): void {
    for (let guard = 0; guard < 1000 && live.deferred.length > 0; guard++) {
      const batch = live.deferred.splice(0, live.deferred.length);
      for (const f of batch) this.dispatchFrame(live, f);
    }
  }

  private handleServerRequest(
    live: LiveThreadProcess,
    rpcId: number | string,
    method: string,
    params: unknown,
  ): void {
    const cls = live.adapter.classifyServerRequest(method, params, {
      threadId: live.providerThreadId,
      activeTurnId: live.activeTurn?.turnId ?? null,
    });
    if (cls.kind === "refuse") {
      if (live.proc.conn.respondError) {
        live.proc.conn.respondError(rpcId, -32601, cls.reason);
      } else {
        live.adapter.respond(live.proc.conn, rpcId, { error: cls.reason });
      }
      return;
    }

    const active = live.activeTurn;
    if (!active) return;
    const thread = getThread(this.db, live.threadId);
    const run = this.db.prepare(`SELECT room_id FROM thread_runs WHERE id = ?`).get(active.runId) as
      | { room_id: number | null }
      | undefined;

    // Per-agent `approval_mode: 'auto'` auto-approves tool/command/file requests
    // into auditable `auto_approved` state, reserving `userInput` for humans.
    if (thread?.approval_mode === "auto" && cls.approvalKind !== "userInput") {
      const options = Array.isArray(cls.sanitized.options)
        ? (cls.sanitized.options as Array<{ optionId?: string; kind?: string }>)
        : [];
      const firstAllowOpt =
        options.find((o) => o.kind === "allow_once")?.optionId ??
        options.find((o) => o.kind?.startsWith("allow"))?.optionId ??
        options[0]?.optionId;
      const wireResponse = live.adapter.formatApprovalResponse
        ? live.adapter.formatApprovalResponse("accept", firstAllowOpt ? { optionId: firstAllowOpt } : undefined)
        : { decision: "accept", ...(firstAllowOpt ? { optionId: firstAllowOpt } : {}) };
      live.adapter.respond(live.proc.conn, rpcId, wireResponse);

      const approvalRow = recordThreadApproval(this.db, {
        threadId: live.threadId,
        runId: active.runId,
        rpcRequestId: JSON.stringify(rpcId),
        kind: cls.approvalKind,
        payload: cls.sanitized,
        state: "auto_approved",
        decision: "accept",
        response: { decision: "accept", ...(firstAllowOpt ? { optionId: firstAllowOpt } : {}), auto: true },
      });
      const ev = appendThreadEvent(this.db, {
        threadId: live.threadId,
        runId: active.runId,
        type: "approval",
        payload: {
          ...cls.sanitized,
          phase: "auto_approved",
          approvalId: approvalRow.id,
          kind: cls.approvalKind,
        },
      });
      publishLiveEvent({
        type: "thread.event",
        project_id: thread.project_id,
        thread_id: live.threadId,
        room_id: run?.room_id ?? null,
        payload: { event: ev },
      });
      publishLiveEvent({
        type: "approval.updated",
        project_id: thread.project_id,
        thread_id: live.threadId,
        room_id: run?.room_id ?? null,
        payload: { action: "auto_approved", approval: approvalRow },
      });
      return;
    }

    const row = recordThreadApproval(this.db, {
      threadId: live.threadId,
      runId: active.runId,
      rpcRequestId: JSON.stringify(rpcId),
      kind: cls.approvalKind,
      payload: cls.sanitized,
      state: "pending",
    });
    live.liveApprovals.set(row.id, rpcId);
    updateThreadRun(this.db, active.runId, { state: "waiting_approval" }, ["running"]);
    updateThread(this.db, live.threadId, { state: "waiting_approval" });

    const ev = appendThreadEvent(this.db, {
      threadId: live.threadId,
      runId: active.runId,
      type: "approval",
      payload: { ...cls.sanitized, phase: "requested", approvalId: row.id, kind: cls.approvalKind },
    });
    publishLiveEvent({
      type: "thread.event",
      project_id: thread?.project_id ?? null,
      thread_id: live.threadId,
      room_id: run?.room_id ?? null,
      payload: { event: ev },
    });
    publishLiveEvent({
      type: "approval.updated",
      project_id: thread?.project_id ?? null,
      thread_id: live.threadId,
      room_id: run?.room_id ?? null,
      payload: { action: "requested", approval: row },
    });
    if (thread) {
      publishLiveEvent({
        type: "thread.updated",
        project_id: thread.project_id,
        thread_id: live.threadId,
        room_id: run?.room_id ?? null,
        payload: { action: "waiting_approval", thread: this.decorateThread(getThread(this.db, live.threadId)!) },
      });
    }
  }

  private handleNotification(live: LiveThreadProcess, method: string, params: unknown): void {
    const normalized = live.adapter.normalizeNotification(method, params);
    if (!normalized) return;
    const matchesActive =
      live.activeTurn !== null &&
      (normalized.turnId === null || normalized.turnId === live.activeTurn.turnId);
    const turnId = normalized.turnId ?? (matchesActive ? live.activeTurn!.turnId : null);
    const thread = getThread(this.db, live.threadId);

    const ev = appendThreadEvent(this.db, {
      threadId: live.threadId,
      runId: matchesActive ? live.activeTurn!.runId : null,
      type: normalized.type,
      payload: { ...normalized.payload, ...(turnId ? { turnId } : {}) },
    });
    publishLiveEvent({
      type: "thread.event",
      project_id: thread?.project_id ?? null,
      thread_id: live.threadId,
      payload: { event: ev },
    });

    if (normalized.agentText !== null && matchesActive) {
      live.agentTexts.push(normalized.agentText);
    }
    if (normalized.turnCompleted) {
      this.finalizeTurn(live, normalized.turnCompleted);
    }
  }

  private finalizeTurn(
    live: LiveThreadProcess,
    completed: { turnId: string | null; status: string; errorMessage: string | null },
  ): void {
    const active = live.activeTurn;
    const turnId = completed.turnId ?? active?.turnId ?? null;
    if (!active || turnId !== active.turnId) return;

    let finalText: string | null = null;
    let state: "completed" | "failed" | "interrupted";
    let errorCode: string | null = null;
    if (completed.status === "completed") {
      state = "completed";
      finalText = mergeFinalText(live.agentTexts);
    } else if (completed.status === "interrupted") {
      state = "interrupted";
    } else {
      state = "failed";
      errorCode = completed.errorMessage?.slice(0, 500) ?? "turn failed";
    }

    const updatedRun = updateThreadRun(
      this.db,
      active.runId,
      {
        state,
        final_text: finalText ?? undefined,
        error_code: errorCode ?? undefined,
      },
      ["running", "waiting_approval"],
    );

    live.activeTurn = null;
    live.liveApprovals.clear();
    live.agentTexts = [];
    expireThreadApprovals(this.db, live.threadId);
    updateThread(this.db, live.threadId, { state: "idle", active_turn_id: null });

    const thread = getThread(this.db, live.threadId);
    if (updatedRun) {
      // Reply linked message if this run came from a cross-thread ask, room summon, or workflow step.
      if (updatedRun.message_id !== null) {
        const reply = replyTextFor(state, finalText, errorCode);
        this.db
          .prepare(
            `UPDATE messages SET reply = ?, status = 'replied', replied_at = ?
             WHERE id = ? AND status IN ('pending', 'seen')`,
          )
          .run(reply, nowIso(), updatedRun.message_id);
      }
      this.notifyFinalized(updatedRun, state, finalText, errorCode);
    }

    if (thread) {
      publishLiveEvent({
        type: "thread.updated",
        project_id: thread.project_id,
        thread_id: live.threadId,
        room_id: updatedRun?.room_id ?? null,
        payload: { action: "turn_finished", state, thread: this.decorateThread(thread) },
      });
      publishLiveEvent({
        type: "git.dirty",
        project_id: thread.project_id,
        thread_id: live.threadId,
        payload: { reason: "turn_finished", runId: active.runId },
      });
    }

    void this.pump(live.threadId);
  }

  private notifyFinalized(
    run: ThreadRun,
    state: "completed" | "failed" | "interrupted",
    finalText: string | null,
    errorCode: string | null,
  ): void {
    for (const fn of turnFinalizedListeners) {
      try {
        fn({
          db: this.db,
          threadId: run.thread_id,
          runId: run.id,
          messageId: run.message_id,
          roomId: run.room_id,
          state,
          finalText,
          errorCode,
        });
      } catch (err) {
        logger.warn({ err, runId: run.id }, "turn finalized listener error");
      }
    }
  }

  private handleChildDeath(live: LiveThreadProcess): void {
    this.live.delete(live.threadId);
    if (!this.db.open) return;
    const inFlightId = live.activeTurn?.runId ?? live.submittingRunId;
    if (inFlightId !== null) {
      updateThreadRun(this.db, inFlightId, {
        state: "unknown",
        error_code: "provider process exited unexpectedly",
      });
    }
    expireThreadApprovals(this.db, live.threadId);
    live.activeTurn = null;
    live.submitting = false;
    live.submittingRunId = null;
    live.liveApprovals.clear();
    const updated = updateThread(this.db, live.threadId, {
      state: "stopped",
      active_turn_id: null,
      pid: null,
    });
    if (updated) {
      publishLiveEvent({
        type: "thread.updated",
        project_id: updated.project_id,
        thread_id: live.threadId,
        payload: { action: "process_exited", thread: this.decorateThread(updated) },
      });
    }
  }
}

let activeThreadManager: ThreadManager | null = null;

export function getThreadManager(): ThreadManager | null {
  return activeThreadManager;
}

export function setThreadManager(manager: ThreadManager | null): void {
  activeThreadManager = manager;
}
