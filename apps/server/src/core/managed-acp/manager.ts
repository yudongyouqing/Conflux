import type { DB } from "../db.js";
import { ManagedExecutor, type ManagedManagerOptions } from "../managed/executor.js";
import { registerManagedExecutor } from "../managed/registry.js";
import { acpAdapter, antigravityAdapter } from "./adapter.js";

/**
 * Managed ACP executors: binds Antigravity (`agy acp`) and generic ACP CLIs
 * onto the runtime-agnostic ManagedExecutor core.
 */

export class ManagedAntigravityManager extends ManagedExecutor {
  constructor(db: DB, opts: ManagedManagerOptions = {}) {
    super(db, { ...opts, adapter: antigravityAdapter });
  }
}

export class ManagedAcpManager extends ManagedExecutor {
  constructor(db: DB, opts: ManagedManagerOptions = {}) {
    super(db, { ...opts, adapter: acpAdapter });
  }
}

let activeAntigravity: ManagedAntigravityManager | null = null;
let activeAcp: ManagedAcpManager | null = null;

export function setManagedAntigravityManager(manager: ManagedAntigravityManager | null): void {
  activeAntigravity = manager;
  registerManagedExecutor("antigravity", manager);
}

export function getManagedAntigravityManager(): ManagedAntigravityManager | null {
  return activeAntigravity;
}

export function setManagedAcpManager(manager: ManagedAcpManager | null): void {
  activeAcp = manager;
  registerManagedExecutor("acp", manager);
}

export function getManagedAcpManager(): ManagedAcpManager | null {
  return activeAcp;
}
