import type { DB } from "../db.js";
import { RUNTIME_REGISTRY } from "../runtime-registry.js";
import type { ManagedExecutor } from "./executor.js";

/**
 * Process-wide registry of managed executors keyed by runtime id ("codex",
 * "claude", "antigravity", "acp", ...). Keeps runtime-agnostic callers
 * (HTTP routes, ask routing, room orchestration, instance stop/resume)
 * decoupled from concrete adapter modules.
 */

const executors = new Map<string, ManagedExecutor>();

export function isManagedRuntime(runtime: string): boolean {
  return Boolean(RUNTIME_REGISTRY[runtime]?.managedCapable) || executors.has(runtime);
}

export function registerManagedExecutor(runtime: string, executor: ManagedExecutor | null): void {
  if (executor) executors.set(runtime, executor);
  else executors.delete(runtime);
}

export function getManagedExecutor(runtime: string): ManagedExecutor | null {
  return executors.get(runtime) ?? null;
}

export function getAllManagedExecutors(): ManagedExecutor[] {
  return [...executors.values()];
}

export function getManagedExecutorForInstance(db: DB, instanceId: string): ManagedExecutor | null {
  const row = db
    .prepare(`SELECT runtime FROM runtime_instances WHERE id = ?`)
    .get(instanceId) as { runtime?: string } | undefined;
  if (row?.runtime) {
    const byRuntime = executors.get(row.runtime);
    if (byRuntime) return byRuntime;
  }
  for (const executor of executors.values()) {
    if (executor.getLiveInstanceIds().includes(instanceId)) return executor;
  }
  return executors.values().next().value ?? null;
}
