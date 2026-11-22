import type { DB } from "../db.js";
import { ManagedExecutor, type ManagedManagerOptions } from "../managed/executor.js";
import { registerManagedExecutor } from "../managed/registry.js";
import { claudeAdapter } from "./adapter.js";

/**
 * The managed Claude Code executor: binds the Claude stream-json SDK adapter
 * onto the runtime-agnostic ManagedExecutor core and registers it under the
 * "claude" runtime key.
 */

export class ManagedClaudeManager extends ManagedExecutor {
  constructor(db: DB, opts: ManagedManagerOptions = {}) {
    super(db, { ...opts, adapter: claudeAdapter });
  }
}

let activeManager: ManagedClaudeManager | null = null;

export function setManagedClaudeManager(manager: ManagedClaudeManager | null): void {
  activeManager = manager;
  registerManagedExecutor("claude", manager);
}

export function getManagedClaudeManager(): ManagedClaudeManager | null {
  return activeManager;
}
