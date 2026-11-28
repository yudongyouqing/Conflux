import type { AgentThread, MicaWatchEvent } from "@conflux/shared";
import { publishLiveEvent, subscribeLiveEvents } from "../event-bus.js";
import { logger } from "../../log.js";
import type { DB } from "../db.js";
import {
  getThread,
  listMicaBoundThreads,
  listPendingThreadApprovals,
  listThreadsByMicaPane,
  updateThread,
} from "../threads/store.js";
import { resolveMicaExecutable } from "../runtime-env.js";
import {
  createDefaultMicaRunner,
  createMicaClient,
  MicaCliError,
  type MicaBadgeOptions,
  type MicaClient,
  type MicaProcessHandle,
  type MicaRunner,
} from "./client.js";

/**
 * Process-level Mica bridge:
 * - keeps at most ONE `mica watch` child alive while any thread is bound,
 * - mirrors pane lifecycle/cwd/prompt events onto the SSE live-event bus,
 * - auto-clears stale `mica_pane_id` bindings when panes disappear,
 * - mirrors Conflux thread state onto Mica tab badges by observing the
 *   decoupled live-event bus (never the executor hot path).
 */

export interface MicaBridgeOptions {
  /** Injectable runner so tests can point everything at a CLI shim. */
  createRunner?: () => MicaRunner;
  watchEvents?: string[];
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  notRunningRetryMs?: number;
  badgeDebounceMs?: number;
}

const DEFAULT_WATCH_EVENTS = ["lifecycle", "exit", "cwd", "prompt", "badge"];

/** Mica caps badge text at 32 Unicode chars; thread names are trimmed to fit. */
const BADGE_TEXT_LIMIT = 32;

function computeBadgeForThread(thread: AgentThread, pendingApprovals: number): MicaBadgeOptions {
  if (pendingApprovals > 0 || thread.state === "waiting_approval") {
    return { state: "attention", text: "等待审批" };
  }
  switch (thread.state) {
    case "running":
      return { state: "running", text: thread.name.slice(0, BADGE_TEXT_LIMIT) };
    case "idle":
      return { state: "idle" };
    case "error":
      return { state: "attention", text: "执行出错" };
    case "stopped":
      return { state: "none" };
  }
}

/**
 * Drop every thread binding to a vanished pane and broadcast the unbind so
 * clients immediately stop offering dead-pane actions.
 */
export function unbindMicaPane(db: DB, paneId: number, reason: string): void {
  for (const thread of listThreadsByMicaPane(db, paneId)) {
    const updated = updateThread(db, thread.id, { mica_pane_id: null });
    if (updated) {
      publishLiveEvent({
        type: "thread.updated",
        project_id: updated.project_id,
        thread_id: updated.id,
        payload: { action: "mica_unbound", reason, thread: updated },
      });
    }
  }
}

export class MicaBridgeService {
  private readonly db: DB;
  private readonly createRunner: () => MicaRunner;
  private readonly watchEvents: string[];
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly notRunningRetryMs: number;
  private readonly badgeDebounceMs: number;

  private watchHandle: MicaProcessHandle | null = null;
  private startingWatch = false;
  private unsubscribeBus: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private readonly badgeTimers = new Map<number, NodeJS.Timeout>();
  private readonly badgeInFlight = new Set<number>();
  private readonly badgeDirty = new Set<number>();

  constructor(db: DB, opts: MicaBridgeOptions = {}) {
    this.db = db;
    this.createRunner =
      opts.createRunner ?? (() => createDefaultMicaRunner(resolveMicaExecutable(db)));
    this.watchEvents = opts.watchEvents ?? DEFAULT_WATCH_EVENTS;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
    this.notRunningRetryMs = opts.notRunningRetryMs ?? 30_000;
    this.badgeDebounceMs = opts.badgeDebounceMs ?? 300;

    this.unsubscribeBus = subscribeLiveEvents((ev) => {
      if (ev.type !== "thread.updated" && ev.type !== "approval.updated") return;
      if (!ev.thread_id) return;
      const thread = this.readThread(ev.thread_id);
      if (thread?.mica_pane_id != null) this.scheduleBadgeSync(thread.mica_pane_id);
    });
  }

  /** Fresh client per call so settings/mica_path changes apply immediately. */
  client(): MicaClient {
    return createMicaClient(this.createRunner());
  }

  private readThread(threadId: string): AgentThread | null {
    try {
      return getThread(this.db, threadId);
    } catch {
      return null;
    }
  }

  /** Called by routes whenever a binding is created or removed. */
  notifyBindingChanged(): void {
    if (this.stopped) return;
    if (listMicaBoundThreads(this.db).length === 0) {
      // Last binding gone: let the watch child wind down instead of idling.
      this.watchHandle?.kill();
      return;
    }
    this.ensureWatching();
  }

  ensureWatching(): void {
    if (this.stopped || this.watchHandle || this.reconnectTimer || this.startingWatch) return;
    void this.startWatch();
  }

  private async startWatch(): Promise<void> {
    if (this.stopped || this.watchHandle || this.startingWatch) return;
    if (listMicaBoundThreads(this.db).length === 0) return;
    this.startingWatch = true;
    try {
      let running: boolean;
      try {
        running = (await this.client().list()).running;
      } catch {
        // CLI missing/broken — retry slowly while bindings exist, never spin.
        this.scheduleProbe();
        return;
      }
      // The await raced with stop() / bindings churn: revalidate so we never
      // leak an orphan watch child (Mica caps watchers at 8) or clobber a
      // handle another startWatch already installed.
      if (this.stopped || this.watchHandle) return;
      if (listMicaBoundThreads(this.db).length === 0) return;
      if (!running) {
        this.scheduleProbe();
        return;
      }
      const handle = this.createRunner().spawn(
        ["watch", "--events", this.watchEvents.join(",")],
        {
          onStdoutLine: (line) => this.handleWatchLine(line),
          onSpawnError: (err) => logger.warn({ err }, "mica watch spawn failed"),
        },
      );
      this.watchHandle = handle;
      this.reconnectAttempts = 0;
      logger.info({ events: this.watchEvents }, "mica watch started");
      void handle.exited.then(() => {
        if (this.watchHandle !== handle) return;
        this.watchHandle = null;
        this.scheduleReconnect();
      });
    } finally {
      this.startingWatch = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts, 6),
      this.reconnectMaxMs,
    );
    this.reconnectAttempts += 1;
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startWatch();
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private scheduleProbe(): void {
    if (this.stopped || this.probeTimer) return;
    const timer = setTimeout(() => {
      this.probeTimer = null;
      void this.startWatch();
    }, this.notRunningRetryMs);
    timer.unref?.();
    this.probeTimer = timer;
  }

  private handleWatchLine(line: string): void {
    let ev: MicaWatchEvent;
    try {
      ev = JSON.parse(line) as MicaWatchEvent;
    } catch {
      return;
    }
    if (typeof ev.pane_id !== "number" || !ev.type) return;
    const threads = listThreadsByMicaPane(this.db, ev.pane_id);
    if (threads.length === 0) return;

    if (ev.type === "pane_closed") {
      unbindMicaPane(this.db, ev.pane_id, "pane_closed");
      if (listMicaBoundThreads(this.db).length === 0) {
        this.watchHandle?.kill();
      }
    }

    for (const thread of threads) {
      publishLiveEvent({
        type: "mica.updated",
        project_id: thread.project_id,
        thread_id: thread.id,
        payload: { event: ev, pane_id: ev.pane_id },
      });
    }
  }

  private scheduleBadgeSync(paneId: number): void {
    const existing = this.badgeTimers.get(paneId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.badgeTimers.delete(paneId);
      void this.syncBadge(paneId);
    }, this.badgeDebounceMs);
    timer.unref?.();
    this.badgeTimers.set(paneId, timer);
  }

  private async syncBadge(paneId: number): Promise<void> {
    if (this.stopped) return;
    if (this.badgeInFlight.has(paneId)) {
      // A fresher state arrived while the previous setBadge was mid-flight;
      // remember it so the finally block reruns with the latest DB state
      // instead of silently dropping the update.
      this.badgeDirty.add(paneId);
      return;
    }
    this.badgeInFlight.add(paneId);
    try {
      const threads = listThreadsByMicaPane(this.db, paneId);
      if (threads.length === 0) return;
      const thread = threads[0];
      const pending = listPendingThreadApprovals(this.db, { threadId: thread.id }).length;
      await this.client().setBadge(paneId, computeBadgeForThread(thread, pending));
    } catch (err) {
      if (err instanceof MicaCliError && err.code === "bad_target") {
        await this.clearStaleBinding(paneId, "badge_bad_target");
      } else if (!(err instanceof MicaCliError && err.code === "spawn_failed")) {
        logger.warn({ err, paneId }, "mica badge sync failed");
      }
    } finally {
      this.badgeInFlight.delete(paneId);
      if (this.badgeDirty.delete(paneId)) {
        void this.syncBadge(paneId);
      }
    }
  }

  async clearStaleBinding(paneId: number, reason: string): Promise<void> {
    unbindMicaPane(this.db, paneId, reason);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    for (const timer of this.badgeTimers.values()) clearTimeout(timer);
    this.badgeTimers.clear();
    this.badgeDirty.clear();
    this.reconnectTimer = null;
    this.probeTimer = null;
    const handle = this.watchHandle;
    this.watchHandle = null;
    handle?.kill();
    await handle?.exited;
    logger.info("mica bridge stopped");
  }
}

let bridgeService: MicaBridgeService | null = null;

export function startMicaBridge(db: DB, opts: MicaBridgeOptions = {}): MicaBridgeService {
  stopMicaBridgeSync();
  bridgeService = new MicaBridgeService(db, opts);
  bridgeService.ensureWatching();
  return bridgeService;
}

export function getMicaBridge(): MicaBridgeService | null {
  return bridgeService;
}

function stopMicaBridgeSync(): void {
  const existing = bridgeService;
  bridgeService = null;
  if (existing) void existing.stop();
}

export async function stopMicaBridge(): Promise<void> {
  const existing = bridgeService;
  bridgeService = null;
  if (existing) await existing.stop();
}
