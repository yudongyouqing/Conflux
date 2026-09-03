import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeId } from "@muiltchat/shared";
import type { DB } from "./db.js";
import { logger } from "../log.js";
import { isRuntimeCommand } from "./runtime-identity.js";
import { hasMcpConnection } from "./mcp-liveness.js";

const execFileAsync = promisify(execFile);

/**
 * Liveness for legacy sessions uses PROCESS PROBING (AgentRecall's approach):
 * a legacy session without an MCP lease is alive iff an OS process is running
 * it. Heartbeats drift (idle windows go stale, dead processes linger a TTL);
 * the process list is ground truth. Sessions with a new-style MCP lease are
 * managed by MCP heartbeats and lease TTL.
 *
 * We don't need to parse conversation ids out of command lines like
 * AgentRecall does — our hooks/MCP registration record the runtime pid in
 * session metadata. The probe only answers "which pids run each runtime",
 * and rows are reconciled against those sets.
 */

export interface ProcessEntry {
  pid: number;
  command: string;
}

export type RuntimePidSnapshot = { [runtime in RuntimeId]: Set<number> };

/** Parse `"<pid> <command>"` lines (Get-CimInstance format) or ps output. */
export function parseProcessLines(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (m) entries.push({ pid: Number(m[1]), command: m[2] });
  }
  return entries;
}

// token matching lives in runtime-identity.ts (single source of truth);
// re-exported here for the existing importers
export { isRuntimeCommand } from "./runtime-identity.js";

/** Does this command line belong to Claude Code? (compatibility wrapper) */
export function isClaudeCommand(command: string): boolean {
  return isRuntimeCommand(command, "claude");
}

export function runtimePidsFrom(entries: ProcessEntry[], runtime: RuntimeId): Set<number> {
  const pids = new Set<number>();
  for (const e of entries) {
    if (isRuntimeCommand(e.command, runtime)) pids.add(e.pid);
  }
  return pids;
}

export function claudePidsFrom(entries: ProcessEntry[]): Set<number> {
  return runtimePidsFrom(entries, "claude");
}

export type ProcessRunner = (command: string, args: string[]) => Promise<string>;

const defaultRunner: ProcessRunner = (command, args) =>
  execFileAsync(command, args).then((r) => r.stdout);

/** Snapshot of live Claude/Codex pids, or null when the probe itself failed. */
export async function probeRuntimePids(
  runner: ProcessRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform
): Promise<RuntimePidSnapshot | null> {
  try {
    const output =
      platform === "win32"
        ? await runner("powershell.exe", [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { "{0} {1}" -f $_.ProcessId, $_.CommandLine } }',
          ])
        : await runner("/bin/ps", ["-axo", "pid=,command="]);
    const entries = parseProcessLines(output);
    return {
      claude: runtimePidsFrom(entries, "claude"),
      codex: runtimePidsFrom(entries, "codex"),
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "liveness probe failed"
    );
    return null;
  }
}

/** Snapshot of live Claude pids (compatibility wrapper). */
export async function probeClaudePids(
  runner: ProcessRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform
): Promise<Set<number> | null> {
  const snapshot = await probeRuntimePids(runner, platform);
  return snapshot?.claude ?? null;
}

function metadataRuntimePid(meta: Record<string, unknown>): { runtime: RuntimeId; pid: number } | null {
  const runtime = meta.runtime === "codex" || meta.runtime === "claude" ? meta.runtime : null;
  if (runtime && typeof meta.runtime_pid === "number" && Number.isInteger(meta.runtime_pid)) {
    return { runtime, pid: meta.runtime_pid };
  }
  // Older Claude hook rows used claude_pid and had no runtime tag.
  if (typeof meta.claude_pid === "number" && Number.isInteger(meta.claude_pid)) {
    return { runtime: "claude", pid: meta.claude_pid };
  }
  return null;
}

/**
 * Reconcile session rows against the probed runtime pid sets:
 *   - row's runtime pid is alive → active + heartbeat refresh (no idle TTL)
 *   - row's runtime pid is gone  → stale immediately (no 2-min TTL lag)
 *   - rows with an MCP lease are skipped; MCP heartbeat / lease TTL owns liveness
 *   - rows without a recorded pid keep the plain heartbeat TTL model
 * Returns how many rows were refreshed / reaped.
 */
export function reconcileRuntimeLiveness(
  db: DB,
  livePids: RuntimePidSnapshot,
  now: Date = new Date()
): { refreshed: number; reaped: number } {
  const rows = db
    .prepare(
      `SELECT id, status, metadata FROM sessions
       WHERE metadata LIKE '%"runtime_pid":%' OR metadata LIKE '%"claude_pid":%'`
    )
    .all() as { id: string; status: string; metadata: string | null }[];

  let refreshed = 0;
  let reaped = 0;
  const nowIso = now.toISOString();
  const refresh = db.prepare(
    `UPDATE sessions
     SET status = 'active', last_heartbeat_at = ?
     WHERE id = ? AND metadata NOT LIKE '%"mcp_connection_id"%'`
  );
  const reap = db.prepare(
    `UPDATE sessions
     SET status = 'stale'
     WHERE id = ? AND status = 'active'
       AND metadata NOT LIKE '%"mcp_connection_id"%'`
  );

  for (const row of rows) {
    if (row.id === "web-console") continue;
    try {
      const parsed: unknown = JSON.parse(row.metadata ?? "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const metadata = parsed as Record<string, unknown>;
      // MCP lease sessions are managed by MCP heartbeats and lease TTL, not PID probing.
      if (hasMcpConnection(metadata)) continue;
      const identity = metadataRuntimePid(metadata);
      if (!identity) continue;
      if (livePids[identity.runtime].has(identity.pid)) {
        const result = refresh.run(nowIso, row.id);
        if (result.changes === 1) refreshed++;
      } else if (row.status === "active") {
        // the process is gone — the conversation is dead, regardless of TTL
        const result = reap.run(row.id);
        if (result.changes === 1) reaped++;
      }
    } catch {
      continue;
    }
  }
  return { refreshed, reaped };
}

/** Reconcile only the legacy Claude pid set (compatibility wrapper). */
export function reconcileLiveness(
  db: DB,
  livePids: Set<number>,
  now: Date = new Date()
): { refreshed: number; reaped: number } {
  return reconcileRuntimeLiveness(db, { claude: livePids, codex: new Set<number>() }, now);
}
