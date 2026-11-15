import type { DB } from "../db.js";
import type { RuntimeAgent } from "@conflux/shared";
import {
  ManagedExecutor,
  type ManagedManagerOptions,
} from "../managed/executor.js";
import type { ManagedLaunchConfig } from "../managed/adapter.js";
import { codexAdapter, defaultCodexLaunch } from "./adapter.js";

/**
 * The managed Codex executor. All scheduling, state and recovery semantics
 * live in the runtime-agnostic core (core/managed/executor.ts); this module
 * binds the Codex app-server adapter (core/managed-codex/adapter.ts) and
 * keeps the process-singleton surface the rest of the server imports.
 */

export type { ManagedManagerOptions } from "../managed/executor.js";
export type { ManagedLaunchConfig } from "../managed/adapter.js";

export class ManagedCodexManager extends ManagedExecutor {
  constructor(db: DB, opts: ManagedManagerOptions = {}) {
    super(db, { ...opts, adapter: codexAdapter });
  }
}

/** Resolve the default app-server launch from settings/env, terminal-safe. */
export function defaultLaunch(db: DB, agent: RuntimeAgent): ManagedLaunchConfig {
  return defaultCodexLaunch(db, agent);
}

// ---- process singleton ----

let activeManager: ManagedCodexManager | null = null;

export function setManagedCodexManager(manager: ManagedCodexManager | null): void {
  activeManager = manager;
}

export function getManagedCodexManager(): ManagedCodexManager | null {
  return activeManager;
}
