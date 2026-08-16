import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DB } from "./db.js";
import { logger } from "../log.js";

const execFileAsync = promisify(execFile);

/**
 * Liveness by PROCESS PROBING (AgentRecall's approach): a conversation is
 * alive iff an OS process is running it. Heartbeats drift (idle windows go
 * stale, dead processes linger a TTL); the process list is ground truth.
 *
 * We don't need to parse conversation ids out of command lines like
 * AgentRecall does — our hooks already record claude_pid in session
 * metadata. The probe only answers "which pids run claude", and rows are
 * reconciled against that set.
 */

export interface ProcessEntry {
  pid: number;
  command: string;
}

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

/** Does this command line belong to a claude process? */
export function isClaudeCommand(command: string): boolean {
  const tokens = command.match(/"[^"]+"|\S+/g) ?? [];
  return tokens.some((t) => {
    const token = t.toLowerCase();
    const basename = token.replace(/^"|"$/g, "").split(/[\\/]/).pop() ?? "";
    if (basename === "claude" || basename === "claude.exe" || basename === "claude.cmd") {
      return true;
    }
    return token.includes("@anthropic-ai/claude-code") || token.includes("claude-code");
  });
}

export function claudePidsFrom(entries: ProcessEntry[]): Set<number> {
  const pids = new Set<number>();
  for (const e of entries) {
    if (isClaudeCommand(e.command)) pids.add(e.pid);
  }
  return pids;
}

export type ProcessRunner = (command: string, args: string[]) => Promise<string>;

const defaultRunner: ProcessRunner = (command, args) =>
  execFileAsync(command, args).then((r) => r.stdout);

/** Snapshot of live claude pids, or null when the probe itself failed. */
export async function probeClaudePids(
  runner: ProcessRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform
): Promise<Set<number> | null> {
  try {
    const output =
      platform === "win32"
        ? await runner("powershell.exe", [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { "{0} {1}" -f $_.ProcessId, $_.CommandLine } }',
          ])
        : await runner("/bin/ps", ["-axo", "pid=,command="]);
    return claudePidsFrom(parseProcessLines(output));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "liveness probe failed"
    );
    return null;
  }
}

/**
 * Reconcile session rows against the probed pid set:
 *   - row's claude_pid is alive  → active + heartbeat refresh (no idle TTL)
 *   - row's claude_pid is gone   → stale immediately (no 2-min TTL lag)
 *   - rows without a recorded pid keep the plain heartbeat TTL model
 * Returns how many rows were refreshed / reaped.
 */
export function reconcileLiveness(
  db: DB,
  livePids: Set<number>,
  now: Date = new Date()
): { refreshed: number; reaped: number } {
  const rows = db
    .prepare(
      `SELECT id, status, metadata FROM sessions WHERE metadata LIKE '%"claude_pid":%'`
    )
    .all() as { id: string; status: string; metadata: string | null }[];

  let refreshed = 0;
  let reaped = 0;
  const nowIso = now.toISOString();
  const refresh = db.prepare(
    `UPDATE sessions SET status = 'active', last_heartbeat_at = ? WHERE id = ?`
  );
  const reap = db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = ? AND status = 'active'`);

  for (const row of rows) {
    if (row.id === "web-console") continue;
    let pid: number | null = null;
    try {
      const v = JSON.parse(row.metadata ?? "{}").claude_pid;
      if (typeof v === "number") pid = v;
    } catch {
      continue;
    }
    if (pid === null) continue;
    if (livePids.has(pid)) {
      refresh.run(nowIso, row.id);
      refreshed++;
    } else if (row.status === "active") {
      // the process is gone — the conversation is dead, regardless of TTL
      reap.run(row.id);
      reaped++;
    }
  }
  return { refreshed, reaped };
}
