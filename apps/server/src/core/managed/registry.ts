import type { RuntimeId } from "@conflux/shared";
import type { DB } from "../db.js";
import type { ManagedExecutor } from "./executor.js";

/**
 * Process-wide registry of managed executors keyed by runtime ("codex", "claude").
 * Keeps runtime-agnostic callers (HTTP routes, ask routing, instance stop/resume)
 * decoupled from concrete adapter modules while preserving single-runtime helpers.
 */

const executors = new Map<RuntimeId, ManagedExecutor>();

export function registerManagedExecutor(runtime: RuntimeId, executor: ManagedExecutor | null): void {
  if (executor) executors.set(runtime, executor);
  else executors.delete(runtime);
}

export function getManagedExecutor(runtime: string): ManagedExecutor | null {
  if (runtime !== "codex" && runtime !== "claude") return null;
  return executors.get(runtime) ?? null;
}

export function getAllManagedExecutors(): ManagedExecutor[] {
  return [...executors.values()];
}

export function getManagedExecutorForInstance(db: DB, instanceId: string): ManagedExecutor | null {
  const row = db
    .prepare(`SELECT runtime FROM runtime_instances WHERE id = ?`)
    .get(instanceId) as { runtime?: string } | undefined;
  if (row?.runtime === "codex" || row?.runtime === "claude") {
    const byRuntime = executors.get(row.runtime);
    if (byRuntime) return byRuntime;
  }
  for (const executor of executors.values()) {
    if (executor.getLiveInstanceIds().includes(instanceId)) return executor;
  }
  return executors.values().next().value ?? null;
}
