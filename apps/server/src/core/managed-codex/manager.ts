import { randomUUID } from "node:crypto";

import type { DB } from "../db.js";
import { nowIso } from "../db.js";
import { logger } from "../../log.js";
import type { RuntimeAgent, RuntimeInstance } from "@conflux/shared";
import { registerSession } from "../sessions.js";
import { cleanTerminalEnv } from "../terminal.js";
import { replyAsk } from "../messages.js";
import {
  createRuntimeInstance,
  failRuntimeInstance,
} from "../runtime-instances.js";
import { buildRuntimeEnv } from "../runtime-agents.js";
import { runtimeDescriptor } from "../runtime-registry.js";
import { getTerminalSettings } from "../app-settings.js";
import { spawnAppServer, type AppServerProcess } from "./process.js";
import { normalizeNotification, mergeFinalText } from "./events.js";
import {
  appendManagedEvent,
  claimNextQueuedRun,
  enqueueManagedTask,
  markRunUnknown,
  updateManagedRun,
  upsertManagedBinding,
  type ManagedRunRow,
} from "./store.js";
import {
  expirePendingApprovals,
  getApproval,
  listPendingApprovals,
  recordApproval,
  resolveApproval,
  isApprovalDecision,
  sanitizeApprovalPayload,
  type ApprovalKind,
} from "./approvals.js";
import type { ManagedTaskInput } from "./types.js";

/**
 * The managed Codex executor. Holds one app-server child + one root thread
 * per managed instance; SQLite stays the source of truth for messages and
 * run state — this class only owns live connections, scheduling and the
 * exactly-once handoff of final results back to the message that asked.
 *
 * Concurrency rules:
 *  - one turn at a time per instance (queue drains FIFO; no steering)
 *  - turn/start is sent ONLY after a queued→submitting claim committed
 *  - the reply to the originating message is written only by the call that
 *    flipped the run into a terminal state (store guard = dedup)
 */

export interface ManagedLaunchConfig {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface ManagedManagerOptions {
  /** Resolve the app-server launch; defaults to the codex settings/env path. */
  resolveLaunch?: (agent: RuntimeAgent) => ManagedLaunchConfig;
}

interface LiveInstance {
  instanceId: string;
  sessionId: string;
  ownerToken: string;
  threadId: string;
  proc: AppServerProcess;
  activeTurn: { runId: number; turnId: string } | null;
  /** Completed agentMessage texts, in completion order, for the active turn. */
  agentTexts: string[];
  /** Approval ids answerable on THIS connection generation, mapped to the
   *  ORIGINAL JSON-RPC request id (number or string — they are different
   *  protocol ids and must round-trip verbatim). */
  liveApprovals: Map<number, number | string>;
}

export class ManagedCodexManager {
  private instances = new Map<string, LiveInstance>();

  constructor(
    private db: DB,
    private opts: ManagedManagerOptions = {},
  ) {}

  /** Spawn app-server, initialize, and create the root thread. */
  async start(
    agent: RuntimeAgent,
    opts: { instance?: RuntimeInstance } = {},
  ): Promise<{ instance: RuntimeInstance; threadId: string }> {
    if (agent.runtime !== "codex") {
      throw Object.assign(new Error("managed execution supports codex only in this milestone"), {
        statusCode: 400,
      });
    }
    if (agent.execution_mode !== "managed") {
      throw Object.assign(new Error("preset is not in managed execution mode"), { statusCode: 400 });
    }
    const instance = opts.instance ?? createRuntimeInstance(this.db, agent);
    const launch = this.opts.resolveLaunch
      ? this.opts.resolveLaunch(agent)
      : defaultLaunch(this.db, agent);

    // The notification router must exist at spawn time, but the LiveInstance
    // it forwards to only exists after initialize/thread/start succeed.
    const router: { live: LiveInstance | null } = { live: null };

    let proc: AppServerProcess;
    try {
      proc = spawnAppServer({
        executable: launch.executable,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        handlers: {
          onNotification: (method, params) => {
            if (router.live) this.handleNotification(router.live, method, params);
          },
          onServerRequest: (id, method, params) => {
            if (router.live) this.handleServerRequest(router.live, id, method, params);
          },
        },
        rpcOptions: { requestTimeoutMs: 30_000 },
      });
    } catch (err) {
      failRuntimeInstance(this.db, instance.id);
      throw err;
    }

    const instanceId = instance.id;
    const sessionId = `codex-managed-${instanceId}`;
    const ownerToken = randomUUID();
    const live: LiveInstance = {
      instanceId,
      sessionId,
      ownerToken,
      threadId: "",
      proc,
      activeTurn: null,
      agentTexts: [],
      liveApprovals: new Map(),
    };

    try {
      const init = (await proc.conn.request("initialize", {
        clientInfo: { name: "conflux", title: "Conflux managed executor", version: "0.3.1" },
        capabilities: null,
      })) as { userAgent?: string };
      logger.info({ instanceId, userAgent: init?.userAgent }, "managed codex app-server initialized");

      const started = (await proc.conn.request("thread/start", {
        cwd: launch.cwd,
        ...(agent.model ? { model: agent.model } : {}),
      })) as { thread?: { id?: string } };
      const threadId = started?.thread?.id;
      if (!threadId) throw new Error("thread/start returned no thread id");
      live.threadId = threadId;

      registerSession(this.db, {
        id: sessionId,
        name: `${agent.name} (managed)`,
        description: `Conflux 受管 Codex 执行端实例 ${instanceId}`,
        project_dir: agent.workdir,
        runtime: "codex",
        identity_source: "internal",
        metadata: {
          agent_id: agent.id,
          runtime_instance_id: instanceId,
          managed_thread_id: threadId,
        },
      });
      upsertManagedBinding(this.db, {
        instanceId,
        sessionId,
        threadId,
        ownerToken,
      });
      router.live = live;
      this.instances.set(instanceId, live);
      this.db
        .prepare(`UPDATE runtime_instances SET state = 'running', updated_at = ? WHERE id = ?`)
        .run(nowIso(), instanceId);
      // Child death outside shutdown: expire this generation's approvals,
      // mark the in-flight run unknown, and end the instance row.
      void live.proc.exited.then(() => {
        if (this.instances.get(instanceId) === live) this.handleInstanceDeath(live);
      });
      logger.info({ instanceId, threadId }, "managed codex instance running");
      return { instance, threadId };
    } catch (err) {
      proc.kill();
      failRuntimeInstance(this.db, instanceId);
      throw err;
    }
  }

  /** Is this session the live executor of a managed instance? */
  isManagedSession(sessionId: string): boolean {
    return this.bindingForSession(sessionId) !== null;
  }

  /** Resolve the live instance bound to a managed session, if any. */
  bindingForSession(sessionId: string): { instanceId: string; threadId: string } | null {
    for (const live of this.instances.values()) {
      if (live.sessionId === sessionId) {
        return { instanceId: live.instanceId, threadId: live.threadId };
      }
    }
    return null;
  }

  /** Enqueue a task and (if idle) kick the scheduler. Database-first. */
  async enqueue(input: ManagedTaskInput): Promise<ManagedRunRow> {
    const run = enqueueManagedTask(this.db, input);
    await this.pump(input.instanceId);
    return run;
  }

  /** Interrupt the ACTIVE turn. Accept ≠ done: the interrupted terminal
   *  notification finalizes the run. */
  async interrupt(
    instanceId: string,
    expectedTurnId?: string | null,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const live = this.instances.get(instanceId);
    if (!live) throw Object.assign(new Error("managed instance not running"), { statusCode: 404 });
    if (!live.activeTurn) {
      return { accepted: false, reason: "no active turn" };
    }
    if (expectedTurnId && expectedTurnId !== live.activeTurn.turnId) {
      return { accepted: false, reason: "active turn changed" };
    }
    await live.proc.conn.request("turn/interrupt", {
      threadId: live.threadId,
      turnId: live.activeTurn.turnId,
    });
    return { accepted: true };
  }

  /** Stop everything this manager owns (server shutdown path). */
  async shutdown(): Promise<void> {
    for (const live of [...this.instances.values()]) {
      this.instances.delete(live.instanceId);
      if (live.activeTurn) {
        markRunUnknown(this.db, live.activeTurn.runId, "manager shutdown mid-turn");
        expirePendingApprovals(this.db, [live.activeTurn.runId]);
        live.activeTurn = null;
      }
      live.proc.kill();
      await live.proc.exited;
      this.db
        .prepare(`UPDATE runtime_instances SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ?`)
        .run(nowIso(), nowIso(), live.instanceId);
    }
  }

  getLiveInstanceIds(): string[] {
    return [...this.instances.keys()];
  }

  /**
   * Test-only: kill the child WITHOUT the graceful shutdown path, so the
   * exited-handler runs exactly like a real crash. The death hook owns the
   * reconciliation (unknown run, expired approvals, ended instance).
   */
  crashForTest(instanceId: string): void {
    const live = this.instances.get(instanceId);
    if (live) live.proc.child.kill("SIGKILL");
  }

  // ---- scheduling ----

  private async pump(instanceId: string): Promise<void> {
    const live = this.instances.get(instanceId);
    if (!live || live.activeTurn) return; // busy: queue keeps waiting
    const claimed = claimNextQueuedRun(this.db, {
      instanceId,
      ownerToken: live.ownerToken,
    });
    if (!claimed) return;
    live.agentTexts = [];
    try {
      const turn = (await live.proc.conn.request("turn/start", {
        threadId: live.threadId,
        input: [{ type: "text", text: claimed.submit_text, text_elements: [] }],
        clientUserMessageId: claimed.request_id ?? undefined,
      })) as { turn?: { id?: string } };
      const turnId = turn?.turn?.id;
      if (!turnId) throw new Error("turn/start returned no turn id");
      const moved = updateManagedRun(
        this.db,
        claimed.id,
        live.ownerToken,
        { state: "running", threadId: live.threadId, turnId },
        { fromStates: ["submitting"] },
      );
      if (!moved) {
        // Another generation owns this run now — do not drive it further.
        markRunUnknown(this.db, claimed.id, "run ownership changed during submit");
        return;
      }
      live.activeTurn = { runId: claimed.id, turnId };
      logger.info({ instanceId, runId: claimed.id, turnId }, "managed turn started");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateManagedRun(
        this.db,
        claimed.id,
        live.ownerToken,
        { state: "failed", errorCode: message.slice(0, 500) },
        { fromStates: ["submitting", "running"] },
      );
      appendManagedEvent(this.db, {
        instanceId,
        runId: claimed.id,
        type: "error",
        payload: { phase: "submit_failed", error: message.slice(0, 500) },
      });
      logger.warn({ instanceId, runId: claimed.id, err: message }, "managed turn submit failed");
      // The instance may still be healthy — keep draining the queue.
      await this.pump(instanceId);
    }
  }

  // ---- notification handling ----

  /**
   * Server-initiated requests: the two item-based approval kinds pause the
   * active run for a human decision. Everything else (legacy approval
   * methods, permission prompts, unknown future surface) is DECLINED
   * explicitly — nothing is ever auto-approved or left hanging.
   */
  private handleServerRequest(
    live: LiveInstance,
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    const kind: ApprovalKind | null =
      method === "item/commandExecution/requestApproval"
        ? "commandExecution"
        : method === "item/fileChange/requestApproval"
          ? "fileChange"
          : null;
    if (!kind) {
      logger.warn({ instanceId: live.instanceId, method, id }, "unhandled app-server request declined");
      live.proc.conn.respond(id, { error: `conflux does not handle ${method}` });
      return;
    }
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p.threadId === "string" && p.threadId !== live.threadId) {
      live.proc.conn.respond(id, { error: "thread mismatch" });
      return;
    }
    const active = live.activeTurn;
    if (!active || (typeof p.turnId === "string" && p.turnId !== active.turnId)) {
      live.proc.conn.respond(id, { error: "no matching active turn" });
      return;
    }
    const row = recordApproval(this.db, {
      runId: active.runId,
      rpcRequestId: JSON.stringify(id),
      kind,
      payload: sanitizeApprovalPayload(kind, p),
    });
    live.liveApprovals.set(row.id, id);
    updateManagedRun(
      this.db,
      active.runId,
      live.ownerToken,
      { state: "waiting_approval" },
      { fromStates: ["running"] },
    );
    appendManagedEvent(this.db, {
      instanceId: live.instanceId,
      runId: active.runId,
      type: "approval",
      payload: { phase: "requested", approvalId: row.id, kind, ...JSON.parse(row.payload) },
    });
    logger.info({ instanceId: live.instanceId, runId: active.runId, approvalId: row.id, kind }, "approval requested");
  }

  /**
   * Apply a user's decision to a pending approval. The store flip is the
   * single source of "who answered"; only its winner forwards the decision
   * on the live connection, and only if this generation still owns it.
   */
  async resolveApproval(
    instanceId: string,
    approvalId: number,
    decision: unknown,
  ): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
    if (!isApprovalDecision(decision)) {
      return { ok: false, status: 400, reason: "decision must be accept | decline | cancel" };
    }
    const live = this.instances.get(instanceId);
    if (!live) return { ok: false, status: 409, reason: "managed instance is not live" };
    // 404 for rows that never existed; 409 for rows that exist but are not
    // answerable anymore (resolved, expired, other generation) — checked
    // BEFORE the store flip so a refused decision never consumes the row.
    const existing = getApproval(this.db, approvalId);
    if (!existing) return { ok: false, status: 404, reason: "approval not found" };
    if (existing.state !== "pending") {
      return { ok: false, status: 409, reason: `approval already ${existing.state}` };
    }
    const originalId = live.liveApprovals.get(approvalId);
    if (originalId === undefined) {
      return { ok: false, status: 409, reason: "approval is not answerable on this connection" };
    }
    const outcome = resolveApproval(this.db, { approvalId, decision });
    if (!outcome.ok) return outcome;
    const row = outcome.row;
    live.liveApprovals.delete(approvalId);
    live.proc.conn.respond(originalId, { decision });
    updateManagedRun(
      this.db,
      row.run_id,
      live.ownerToken,
      { state: "running" },
      { fromStates: ["waiting_approval"] },
    );
    appendManagedEvent(this.db, {
      instanceId,
      runId: row.run_id,
      type: "approval",
      payload: { phase: "resolved", approvalId, decision },
    });
    logger.info({ instanceId, approvalId, decision }, "approval resolved by user");
    return { ok: true };
  }

  /** Queue snapshot + pending approvals for the external status surface. */
  instanceStatus(instanceId: string): {
    threadId: string;
    activeRun: { runId: number; turnId: string; state: string } | null;
    queuedRunIds: number[];
    pendingApprovals: Array<{ id: number; kind: string; payload: unknown }>;
  } {
    const live = this.instances.get(instanceId);
    if (!live) throw Object.assign(new Error("managed instance not running"), { statusCode: 404 });
    const queued = this.db
      .prepare(`SELECT id FROM managed_codex_runs WHERE instance_id = ? AND state = 'queued' ORDER BY created_at, id`)
      .all(instanceId) as { id: number }[];
    const pending = listPendingApprovals(
      this.db,
      live.activeTurn ? [live.activeTurn.runId] : [],
    ).filter((row) => live.liveApprovals.has(row.id));
    return {
      threadId: live.threadId,
      activeRun: live.activeTurn
        ? {
            runId: live.activeTurn.runId,
            turnId: live.activeTurn.turnId,
            state: "running",
          }
        : null,
      queuedRunIds: queued.map((q) => q.id),
      pendingApprovals: pending.map((row) => ({
        id: row.id,
        kind: row.request_kind,
        payload: JSON.parse(row.payload) as unknown,
      })),
    };
  }

  /** Child died outside an explicit shutdown: reconcile everything it owned. */
  private handleInstanceDeath(live: LiveInstance): void {
    this.instances.delete(live.instanceId);
    const runIds = live.activeTurn ? [live.activeTurn.runId] : [];
    if (live.activeTurn) markRunUnknown(this.db, live.activeTurn.runId, "app-server exited mid-turn");
    expirePendingApprovals(this.db, runIds);
    appendManagedEvent(this.db, {
      instanceId: live.instanceId,
      runId: live.activeTurn?.runId ?? null,
      type: "status",
      payload: { phase: "instance_died" },
    });
    this.db
      .prepare(`UPDATE runtime_instances SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ?`)
      .run(nowIso(), nowIso(), live.instanceId);
    logger.warn({ instanceId: live.instanceId }, "managed codex instance died");
  }

  private handleNotification(live: LiveInstance, method: string, params: unknown): void {
    const normalized = normalizeNotification(method, params);
    if (!normalized) return;
    const ids = (params ?? {}) as { threadId?: string; turnId?: string; item?: unknown };
    const turnId = typeof ids.turnId === "string" ? ids.turnId : live.activeTurn?.turnId ?? null;
    appendManagedEvent(this.db, {
      instanceId: live.instanceId,
      runId: live.activeTurn?.runId ?? null,
      type: normalized.type,
      payload: { ...normalized.payload, ...(turnId ? { turnId } : {}) },
    });

    // Track completed agentMessage texts for the final merge.
    if (
      method === "item/completed" &&
      typeof ids.item === "object" &&
      ids.item !== null &&
      (ids.item as { type?: string }).type === "agentMessage"
    ) {
      const text = (ids.item as { text?: unknown }).text;
      if (typeof text === "string") live.agentTexts.push(text);
    }

    if (method === "turn/completed") {
      this.finalizeTurn(live, params);
    }
  }

  private finalizeTurn(live: LiveInstance, params: unknown): void {
    const turn = (params as { turn?: { id?: string; status?: string; error?: { message?: string } | null } })
      .turn;
    const status = turn?.status;
    const turnId = turn?.id ?? live.activeTurn?.turnId ?? null;
    const active = live.activeTurn;
    // A completion for a turn we are not driving (or already finalized) is
    // recorded as an event only — never a second reply.
    if (!active || turnId !== active.turnId) return;
    live.activeTurn = null;

    const fromStates = ["running", "waiting_approval"] as const;
    let finalText: string | null = null;
    let state: "completed" | "failed" | "interrupted";
    let errorCode: string | null = null;
    if (status === "completed") {
      state = "completed";
      finalText = mergeFinalText(live.agentTexts);
    } else if (status === "failed") {
      state = "failed";
      errorCode = turn?.error?.message?.slice(0, 500) ?? "turn failed";
    } else if (status === "interrupted") {
      state = "interrupted";
    } else {
      // inProgress/unknown completion — treat as failed to need attention
      state = "failed";
      errorCode = `unexpected terminal status: ${String(status)}`;
    }

    const moved = updateManagedRun(
      this.db,
      active.runId,
      live.ownerToken,
      { state, finalText: finalText ?? undefined, errorCode: errorCode ?? undefined },
      { fromStates: [...fromStates] },
    );
    if (moved) {
      // Exactly-once reply: only the writer that flipped the terminal state
      // answers the originating message.
      const run = moved;
      const reply =
        state === "completed"
          ? (finalText ?? "(受管任务完成，无最终文本)")
          : state === "interrupted"
            ? `任务被中断${errorCode ? `：${errorCode}` : ""}`
            : `任务失败：${errorCode ?? "未知错误"}`;
      try {
        replyAsk(this.db, run.message_id, live.sessionId, reply);
      } catch (err) {
        logger.warn(
          { runId: run.id, err: err instanceof Error ? err.message : String(err) },
          "managed run reply write-back failed",
        );
      }
    }
    // Drain the queue for the next task.
    void this.pump(live.instanceId).catch(() => {});
  }
}

/** Resolve the default app-server launch from settings/env, terminal-safe. */
export function defaultLaunch(db: DB, agent: RuntimeAgent): ManagedLaunchConfig {
  const settings = getTerminalSettings(db);
  const def = runtimeDescriptor(agent.runtime);
  const defaultExe = def.settingsKey ? settings[def.settingsKey] : def.executable;
  const executable = process.env[def.executableEnv] || defaultExe;
  const env = buildRuntimeEnv(agent, cleanTerminalEnv());
  const dataDir = db.name.replace(/[/\\][^/\\]+$/, "");
  env.CONFLUX_HOME = dataDir;
  return {
    executable,
    args: ["app-server"],
    env,
    cwd: agent.workdir || process.cwd(),
  };
}

// ---- process singleton ----

let activeManager: ManagedCodexManager | null = null;

export function setManagedCodexManager(manager: ManagedCodexManager | null): void {
  activeManager = manager;
}

export function getManagedCodexManager(): ManagedCodexManager | null {
  return activeManager;
}

/** Does this session belong to a live managed instance in this process?
 *  Offline managed sessions keep the ordinary mailbox semantics — only a
 *  live executor is dispatched to. */
export function isManagedTarget(sessionId: string): boolean {
  const manager = getManagedCodexManager();
  return manager?.isManagedSession(sessionId) === true;
}
