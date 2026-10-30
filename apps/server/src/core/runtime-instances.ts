import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RuntimeAgent, RuntimeId, RuntimeInstance } from "@conflux/shared";
import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { getSession, endSession } from "./sessions.js";
import { getSetting } from "./app-settings.js";
import { isRuntimeCommand } from "./runtime-identity.js";
import { getRuntimeAgent, startRuntimeAgent, type StartRuntimeOptions } from "./runtime-agents.js";
import { STALE_AFTER_MS } from "../config.js";

export interface ProcessIdentity {
  runtime: RuntimeId | null;
  token: string;
}
export interface RuntimeProcessIO {
  /** null means unverifiable; exited means absence was verified. */
  inspect?: (pid: number) => ProcessIdentity | "exited" | null;
  terminate?: (pid: number) => void;
}

const inspectionCache = new WeakMap<
  DB,
  Map<number, { at: number; identity: ProcessIdentity | "exited" | null }>
>();
function listingIO(db: DB, io: RuntimeProcessIO): RuntimeProcessIO {
  const perRead = new Map<number, ProcessIdentity | "exited" | null>();
  const cache = inspectionCache.get(db) ?? new Map();
  if (cache.size > 400) cache.clear();
  inspectionCache.set(db, cache);
  if (!io.inspect && process.platform === "win32") {
    const selected = db
      .prepare(
        `SELECT runtime_pid FROM runtime_instances WHERE runtime_pid IS NOT NULL
      ORDER BY CASE WHEN state IN ('starting', 'running', 'stale') THEN 0 ELSE 1 END, created_at DESC LIMIT 200`,
      )
      .all() as { runtime_pid: number }[];
    const missing = [...new Set(selected.map((row) => row.runtime_pid))].filter((pid) => {
      const cached = cache.get(pid);
      return !cached || Date.now() - cached.at >= 3000;
    });
    if (missing.length) {
      const identities = inspectWindowsProcesses(missing);
      for (const pid of missing)
        cache.set(pid, { at: Date.now(), identity: identities.get(pid) ?? null });
    }
  }
  return {
    ...io,
    inspect: (pid) => {
      if (perRead.has(pid)) return perRead.get(pid)!;
      const cached = io.inspect ? undefined : cache.get(pid);
      const identity =
        cached && Date.now() - cached.at < 3000
          ? cached.identity
          : !io.inspect && process.platform === "win32"
            ? null
            : (io.inspect ?? inspectRuntimeProcess)(pid);
      perRead.set(pid, identity);
      if (!io.inspect) {
        cache.set(pid, { at: Date.now(), identity });
      }
      return identity;
    },
  };
}

interface InstanceRow {
  id: string;
  preset_id: number;
  preset_name: string;
  runtime: RuntimeId;
  workdir: string | null;
  preset_snapshot: string;
  session_id: string | null;
  runtime_pid: number | null;
  process_token: string | null;
  state: RuntimeInstance["state"];
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  resumed_from: string | null;
  error: string | null;
  stop_requested_at: string | null;
}

interface SafeSnapshot {
  name: string;
  runtime: RuntimeId;
  workdir: string | null;
  model: string | null;
  instructions: string | null;
  credentialsHash: string;
}

function conflict(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}

function rowFor(db: DB, id: string): InstanceRow {
  const row = db.prepare("SELECT * FROM runtime_instances WHERE id = ?").get(id) as
    InstanceRow | undefined;
  if (!row) throw Object.assign(new Error("runtime instance not found"), { statusCode: 404 });
  return row;
}

function credentialsHash(agent: RuntimeAgent): string {
  return createHash("sha256")
    .update(JSON.stringify([agent.base_url, agent.api_key, agent.extra_env]))
    .digest("hex");
}

export function createRuntimeInstance(
  db: DB,
  agent: RuntimeAgent,
  resumedFrom: string | null = null,
): RuntimeInstance {
  const id = randomUUID();
  const now = nowIso();
  const snapshot: SafeSnapshot = {
    name: agent.name,
    runtime: agent.runtime,
    workdir: agent.workdir,
    model: agent.model,
    instructions: agent.instructions,
    credentialsHash: credentialsHash(agent),
  };
  db.prepare(
    `INSERT INTO runtime_instances
    (id, preset_id, preset_name, runtime, workdir, preset_snapshot, state, created_at, updated_at, resumed_from)
    VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
  ).run(
    id,
    agent.id,
    agent.name,
    agent.runtime,
    agent.workdir,
    JSON.stringify(snapshot),
    now,
    now,
    resumedFrom,
  );
  return toPublic(db, rowFor(db, id), {});
}

export function failRuntimeInstance(db: DB, id: string): void {
  db.prepare(
    "UPDATE runtime_instances SET state = 'failed', error = 'runtime launch failed', updated_at = ?, ended_at = ? WHERE id = ?",
  ).run(nowIso(), nowIso(), id);
}

/** A terminal opener PID never establishes ownership. Only runtime hook/MCP identity does. */
export function bindRuntimeInstance(
  db: DB,
  id: string,
  sessionId: string,
  pid: number,
  io: RuntimeProcessIO = {},
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const row = db.prepare("SELECT * FROM runtime_instances WHERE id = ?").get(id) as
    InstanceRow | undefined;
  const session = getSession(db, sessionId);
  if (
    !row ||
    !session ||
    row.state === "ended" ||
    session.runtime !== row.runtime ||
    session.runtime_pid !== pid
  )
    return false;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(session.metadata ?? "{}");
  } catch {
    return false;
  }
  if (meta.runtime_instance_id !== id || meta.agent_id !== row.preset_id) return false;
  const identity =
    row.process_token && row.runtime_pid === pid && row.session_id === sessionId
      ? listingIO(db, io).inspect!(pid)
      : (io.inspect ?? inspectRuntimeProcess)(pid);
  if (!identity || identity === "exited" || identity.runtime !== row.runtime || !identity.token)
    return false;
  // Adoption can replace a temporary MCP session with its hook conversation,
  // but it must never move the instance to a different OS process.
  if (row.process_token && (row.process_token !== identity.token || row.runtime_pid !== pid))
    return false;
  db.prepare(
    `UPDATE runtime_instances SET session_id = ?, runtime_pid = ?, process_token = ?,
    state = 'running', error = NULL, ended_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(sessionId, pid, identity.token, nowIso(), id);
  return true;
}

function ownedSession(db: DB, row: InstanceRow): boolean {
  if (!row.session_id || !row.runtime_pid) return false;
  const session = getSession(db, row.session_id);
  if (!session || session.runtime !== row.runtime || session.runtime_pid !== row.runtime_pid)
    return false;
  try {
    const meta = JSON.parse(session.metadata ?? "{}");
    if (meta.runtime_instance_id !== row.id || meta.agent_id !== row.preset_id) return false;
  } catch {
    return false;
  }
  const current = getSetting(db, `${row.runtime}-current:${row.runtime_pid}`);
  return !current || current === row.session_id;
}

function resumableSession(db: DB, row: InstanceRow): string | null {
  if (!row.session_id) return null;
  const session = getSession(db, row.session_id);
  if (!session) return null;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(session.metadata ?? "{}");
  } catch {
    return null;
  }
  if (row.runtime === "codex" && typeof meta.codex_session_id === "string")
    return meta.codex_session_id;
  return meta.temp === true ? null : session.id;
}

function toPublic(db: DB, row: InstanceRow, io: RuntimeProcessIO): RuntimeInstance {
  const session = row.session_id ? getSession(db, row.session_id) : null;
  const identity = row.runtime_pid ? (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid) : null;
  const sameProcess =
    !!identity &&
    identity !== "exited" &&
    identity.runtime === row.runtime &&
    identity.token === row.process_token;
  const gone = identity === "exited" || (!!identity && identity.token !== row.process_token);
  const canStop =
    sameProcess && ownedSession(db, row) && row.state !== "ended" && row.state !== "failed";
  const terminal = ["ended", "stale", "failed"].includes(row.state);
  const root = row.resumed_from ?? row.id;
  const activeResume = db
    .prepare(
      "SELECT id FROM runtime_instances WHERE resumed_from = ? AND (state IN ('starting', 'running', 'stale') OR (state = 'failed' AND ended_at IS NULL)) AND id != ?",
    )
    .get(root, row.id);
  let credentialsValid = false;
  const preset = getRuntimeAgent(db, row.preset_id);
  try {
    credentialsValid =
      !!preset &&
      credentialsHash(preset) === (JSON.parse(row.preset_snapshot) as SafeSnapshot).credentialsHash;
  } catch {
    /* invalid snapshot is not resumable */
  }
  let limitation: string | null = null;
  if (!row.runtime_pid || !row.process_token)
    limitation = "尚未绑定可验证的运行时进程，无法安全停止";
  else if (!ownedSession(db, row)) limitation = "会话与实例的进程归属不匹配，拒绝停止";
  else if (!sameProcess && !gone) limitation = "无法验证进程身份，拒绝停止或恢复";
  else if (gone && identity !== "exited") limitation = "原进程 PID 已被复用，拒绝停止";
  if (terminal && !credentialsValid)
    limitation = "原预设已删除或连接配置已变更，无法恢复；请从预设重新启动";
  else if (terminal && !resumableSession(db, row)) limitation = "没有可恢复的原始对话标识";
  else if (terminal && sameProcess) limitation = "原运行时进程仍在运行，无法重复恢复";
  else if (activeResume) limitation = "原恢复实例尚未确认退出，无法重复恢复";
  if (row.stop_requested_at && !gone) limitation = "已请求停止，等待进程退出";
  const { preset_snapshot: _snapshot, process_token: _token, ...safe } = row;
  return {
    ...safe,
    can_stop: canStop,
    can_resume:
      terminal && gone && credentialsValid && !!resumableSession(db, row) && !activeResume,
    limitation,
    last_seen: session?.last_heartbeat_at ?? null,
  };
}

function refreshInstances(db: DB, io: RuntimeProcessIO, onlyId?: string): void {
  db.prepare(
    "UPDATE runtime_instances SET state = 'failed', error = 'runtime did not register within two minutes', updated_at = ? WHERE state = 'starting' AND created_at < ?",
  ).run(nowIso(), new Date(Date.now() - 120_000).toISOString());
  const rows = db
    .prepare(
      `SELECT * FROM runtime_instances WHERE state IN ('running', 'stale') ${onlyId ? "AND id = ?" : ""} ORDER BY updated_at DESC LIMIT 200`,
    )
    .all(...(onlyId ? [onlyId] : [])) as InstanceRow[];
  for (const row of rows) {
    let state = row.state;
    const session = row.session_id ? getSession(db, row.session_id) : null;
    if (row.state === "starting" && Date.now() - Date.parse(row.created_at) > 120_000)
      state = "failed";
    if (row.runtime_pid) {
      const identity = (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid);
      if (identity === "exited" || (identity && identity.token !== row.process_token))
        state = "ended";
      else if (
        session?.status === "ended" ||
        !session ||
        Date.now() - Date.parse(session.last_heartbeat_at) > STALE_AFTER_MS
      )
        state = "stale";
      else if (row.state !== "starting") state = "running";
    }
    if (state !== row.state) {
      db.prepare(
        "UPDATE runtime_instances SET state = ?, updated_at = ?, ended_at = ? WHERE id = ?",
      ).run(state, nowIso(), state === "ended" || state === "failed" ? nowIso() : null, row.id);
    }
  }
}

export function listRuntimeInstances(db: DB, io: RuntimeProcessIO = {}): RuntimeInstance[] {
  const probes = listingIO(db, io);
  refreshInstances(db, probes);
  return (
    db
      .prepare(
        "SELECT * FROM runtime_instances ORDER BY CASE WHEN state IN ('starting', 'running', 'stale') THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 200",
      )
      .all() as InstanceRow[]
  ).map((row) => toPublic(db, row, probes));
}

export function refreshRuntimeInstances(db: DB): void {
  refreshInstances(db, listingIO(db, {}));
}

export function getRuntimeInstance(
  db: DB,
  id: string,
  io: RuntimeProcessIO = {},
): RuntimeInstance | null {
  const row = db.prepare("SELECT * FROM runtime_instances WHERE id = ?").get(id) as
    InstanceRow | undefined;
  return row ? toPublic(db, row, io) : null;
}

export function stopRuntimeInstance(
  db: DB,
  id: string,
  io: RuntimeProcessIO = {},
): RuntimeInstance {
  const row = rowFor(db, id);
  const current = toPublic(db, row, io);
  if (!current.can_stop || !row.runtime_pid)
    conflict(current.limitation ?? "runtime instance cannot be stopped safely");
  // Probe again immediately before termination to catch a PID reused since listing.
  const identity = (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid);
  if (
    !identity ||
    identity === "exited" ||
    identity.runtime !== row.runtime ||
    identity.token !== row.process_token ||
    !ownedSession(db, row)
  ) {
    conflict("process identity changed; refusing to stop");
  }
  (io.terminate ?? terminateRuntimeProcess)(row.runtime_pid);
  const after = (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid);
  const exited = after === "exited" || (after && after.token !== row.process_token);
  // SIGTERM can be delayed or ignored. Keep ownership and the stop control
  // available until absence of the original process is actually verified.
  if (exited) {
    db.prepare(
      "UPDATE runtime_instances SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ?",
    ).run(nowIso(), nowIso(), id);
    if (row.session_id) endSession(db, row.session_id);
  } else {
    db.prepare(
      "UPDATE runtime_instances SET stop_requested_at = ?, updated_at = ? WHERE id = ?",
    ).run(nowIso(), nowIso(), id);
  }
  return toPublic(db, rowFor(db, id), io);
}

export function resumeRuntimeInstance(
  db: DB,
  id: string,
  opts: StartRuntimeOptions & RuntimeProcessIO = {},
): { started: true; instance: RuntimeInstance } {
  refreshInstances(db, opts, id);
  const verifiedRow = rowFor(db, id);
  const verified = toPublic(db, verifiedRow, opts);
  if (!verified.can_resume) conflict(verified.limitation ?? "runtime instance cannot be resumed");
  const reservation = db
    .transaction(() => {
      const row = rowFor(db, id);
      if (
        row.state !== verifiedRow.state ||
        row.session_id !== verifiedRow.session_id ||
        row.runtime_pid !== verifiedRow.runtime_pid ||
        row.process_token !== verifiedRow.process_token
      )
        conflict("runtime instance changed while preparing resume");
      const preset = getRuntimeAgent(db, row.preset_id)!;
      const snapshot = JSON.parse(row.preset_snapshot) as SafeSnapshot;
      if (!preset || credentialsHash(preset) !== snapshot.credentialsHash)
        conflict("runtime preset connection configuration changed");
      if (
        db
          .prepare(
            "SELECT id FROM runtime_instances WHERE resumed_from = ? AND (state IN ('starting', 'running', 'stale') OR (state = 'failed' AND ended_at IS NULL)) AND id != ?",
          )
          .get(row.resumed_from ?? row.id, row.id)
      )
        conflict("conversation already has an active resume instance");
      const agent: RuntimeAgent = { ...preset, ...snapshot };
      const next = createRuntimeInstance(db, agent, row.resumed_from ?? row.id);
      return { agent, next, resumeSessionId: resumableSession(db, row)! };
    })
    .immediate();
  try {
    return startRuntimeAgent(db, reservation.agent.id, {
      ...opts,
      agent: reservation.agent,
      instance: reservation.next,
      resumeSessionId: reservation.resumeSessionId,
    });
  } catch (error) {
    failRuntimeInstance(db, reservation.next.id);
    throw error;
  }
}

/** Inspect only the selected PID; creation identity is never inferred from a terminal host. */
export function inspectRuntimeProcess(pid: number): ProcessIdentity | "exited" | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    let token: string;
    let command: string;
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ token = $p.CreationDate.ToUniversalTime().ToString('o'); command = $p.CommandLine } | ConvertTo-Json -Compress } else { Write-Output 'exited' }`;
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 2000, windowsHide: true },
      ).trim();
      if (output === "exited") return "exited";
      const data = JSON.parse(output) as { token: string; command: string };
      token = data.token;
      command = data.command;
    } else if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      token = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } else {
      token = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
    }
    if (!token || !command) return null;
    return runtimeIdentity(token, command);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") return "exited";
      }
    }
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ESRCH") return "exited";
    }
    return null;
  }
}

function runtimeIdentity(token: string, command: string): ProcessIdentity {
  const tokens = command.match(/"[^"]+"|\S+/g) ?? [];
  const executable =
    (tokens[0] ?? "").replace(/^"|"$/g, "").replace(/\\/g, "/").split("/").pop() ?? "";
  // User prompts later in argv must never establish runtime identity.
  const prefix = /^(node|node\.exe|bun|bun\.exe)$/i.test(executable)
    ? tokens.slice(0, 2).join(" ")
    : (tokens[0] ?? "");
  return {
    token,
    runtime:
      (["claude", "codex"] as const).find((candidate) => isRuntimeCommand(prefix, candidate)) ??
      null,
  };
}

function inspectWindowsProcesses(pids: number[]): Map<number, ProcessIdentity | "exited" | null> {
  const selected = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const result = new Map<number, ProcessIdentity | "exited" | null>();
  if (!selected.length) return result;
  const filter = selected.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{ pid = $_.ProcessId; token = $_.CreationDate.ToUniversalTime().ToString('o'); command = $_.CommandLine } }) | ConvertTo-Json -Compress`;
  try {
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    ).trim();
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as {
      pid: number;
      token?: string;
      command?: string;
    }[];
    for (const pid of selected) result.set(pid, "exited");
    for (const row of rows)
      if (selected.includes(row.pid))
        result.set(
          row.pid,
          row.token && row.command ? runtimeIdentity(row.token, row.command) : null,
        );
  } catch {
    for (const pid of selected) result.set(pid, null);
  }
  return result;
}

function terminateRuntimeProcess(pid: number): void {
  if (process.platform === "win32") {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], {
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
  } else {
    process.kill(pid, "SIGTERM");
  }
}
