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
import { getManagedCodexManager } from "./managed-codex/manager.js";
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
  const storedToken = row.process_token;
  if (
    storedToken &&
    (classifyProcessToken(storedToken, identity.token) !== "same" || row.runtime_pid !== pid)
  )
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
  // Managed executor instances: the holder (this server process) owns the
  // child outright, so stop/resume capabilities key off the managed binding
  // and the live manager rather than the external process-identity chain.
  const managedBinding = db
    .prepare(`SELECT thread_id FROM managed_codex_bindings WHERE instance_id = ?`)
    .get(row.id) as { thread_id: string } | undefined;
  if (managedBinding) {
    const manager = getManagedCodexManager();
    const held = manager?.getLiveInstanceIds().includes(row.id) === true;
    const terminal = ["ended", "stale", "failed"].includes(row.state);
    const presetExists = !!getRuntimeAgent(db, row.preset_id);
    const { preset_snapshot: _s, process_token: _t, ...safe } = row;
    let limitation: string | null = null;
    if (!held && !terminal) {
      limitation = "受管实例由 Conflux 服务进程持有，请通过服务端/Web 控制";
    } else if (terminal && !presetExists) {
      limitation = "原预设已删除，无法恢复；请从预设重新启动";
    }
    return {
      ...safe,
      can_stop: held,
      can_resume: terminal && presetExists,
      limitation,
      last_seen: row.session_id ? getSession(db, row.session_id)?.last_heartbeat_at ?? null : null,
    };
  }
  const session = row.session_id ? getSession(db, row.session_id) : null;
  const identity = row.runtime_pid ? (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid) : null;
  const relation =
    row.process_token && identity && identity !== "exited"
      ? classifyProcessToken(row.process_token, identity.token)
      : null;
  const sameProcess = relation === "same" && identity !== "exited" && identity?.runtime === row.runtime;
  // Only a CONFIRMED exit or replacement ends the instance. A "changed"
  // relation (same generation, mutated descriptor fields) means the live
  // process was re-parented or retitled — it must NOT be treated as gone,
  // or the row could be resumed while the original process still runs.
  const gone = identity === "exited" || relation === "replaced";
  const changedButAlive = relation === "changed";
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
  else if (changedButAlive) limitation = "进程仍在运行但身份字段已变化（父进程/进程组/命令行），拒绝停止与恢复";
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
      // A "changed" relation (live process, mutated descriptors) must NOT
      // end the row — ended rows become resumable and would double-run a
      // session whose original process is still alive.
      const refreshRelation =
        row.process_token && identity && identity !== "exited"
          ? classifyProcessToken(row.process_token, identity.token)
          : null;
      if (identity === "exited" || refreshRelation === "replaced") state = "ended";
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

export async function stopRuntimeInstance(
  db: DB,
  id: string,
  io: RuntimeProcessIO = {},
): Promise<RuntimeInstance> {
  // Managed instances are stopped by their holder (the server spawned the
  // child; pid ownership is intrinsic, no external identity proof needed).
  const managedRow = db
    .prepare(`SELECT thread_id FROM managed_codex_bindings WHERE instance_id = ?`)
    .get(id) as { thread_id: string } | undefined;
  if (managedRow) {
    const manager = getManagedCodexManager();
    if (!manager || !manager.getLiveInstanceIds().includes(id)) {
      conflict("受管实例由 Conflux 服务进程持有，请通过服务端/Web 停止");
    }
    await manager.stopManagedInstance(id);
    return toPublic(db, rowFor(db, id), io);
  }
  const row = rowFor(db, id);
  const current = toPublic(db, row, io);
  if (!current.can_stop || !row.runtime_pid) {
    // A stop was requested earlier and the termination signal was sent;
    // the follow-up inspection right after SIGTERM can lose the race with
    // the process exit. When a later stop finds the process verifiably
    // gone, complete the stop instead of refusing — the operator asked for
    // exactly this outcome.
    if (row.stop_requested_at && row.runtime_pid) {
      const identity = (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid);
      const completionRelation =
        row.process_token && identity && identity !== "exited"
          ? classifyProcessToken(row.process_token, identity.token)
          : null;
      const exited = identity === "exited" || completionRelation === "replaced";
      if (exited) {
        db.prepare(
          "UPDATE runtime_instances SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ?",
        ).run(nowIso(), nowIso(), id);
        if (row.session_id) endSession(db, row.session_id);
        return toPublic(db, rowFor(db, id), io);
      }
    }
    conflict(current.limitation ?? "runtime instance cannot be stopped safely");
  }
  // Probe again immediately before termination to catch a PID reused since listing.
  const identity = (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid);
  if (
    !identity ||
    identity === "exited" ||
    identity.runtime !== row.runtime ||
    !row.process_token || classifyProcessToken(row.process_token, identity.token) !== "same" ||
    !ownedSession(db, row)
  ) {
    conflict("process identity changed; refusing to stop");
  }
  (io.terminate ?? terminateRuntimeProcess)(row.runtime_pid);
  const after = (io.inspect ?? inspectRuntimeProcess)(row.runtime_pid);
  const afterRelation =
    row.process_token && after && after !== "exited"
      ? classifyProcessToken(row.process_token, after.token)
      : null;
  // Only confirmed death or a confirmed replacement verifies the stop; a
  // post-termination "changed" reading means the process is still alive
  // with mutated identity fields and the stop stays requested.
  const exited = after === "exited" || afterRelation === "replaced";
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

export async function resumeRuntimeInstance(
  db: DB,
  id: string,
  opts: StartRuntimeOptions & RuntimeProcessIO = {},
): Promise<{ started: true; instance: RuntimeInstance }> {
  // Managed instances resume by rejoining their SAVED thread on a fresh
  // app-server child — the terminal resume path (session identity, process
  // tokens) does not apply to a Conflux-held process.
  const managedRow = db
    .prepare(`SELECT thread_id FROM managed_codex_bindings WHERE instance_id = ?`)
    .get(id) as { thread_id: string } | undefined;
  if (managedRow) {
    const manager = getManagedCodexManager();
    if (!manager) {
      conflict("受管实例由 Conflux 服务进程持有，请通过服务端/Web 恢复");
    }
    const row = rowFor(db, id);
    const preset = getRuntimeAgent(db, row.preset_id)!;
    if (!preset) conflict("原预设已删除，无法恢复；请从预设重新启动");
    const { instance } = await manager.resumeInstance(id, preset);
    return { started: true, instance };
  }
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
    return await startRuntimeAgent(db, reservation.agent.id, {
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
      // cmdline is NUL-separated: argv elements containing spaces would
      // lose their boundaries (and their basename) under naive
      // whitespace tokenization, so re-quote them the way the tokenizer
      // below already understands.
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
        .join(" ");
    } else {
      // macOS has no /proc, and ps exposes no sub-second creation stamp:
      // lstart is one-second granular, so a REUSED pid landing in the same
      // start second could still match on time alone. Investigation of
      // deployable sources: lstart/etime (1 s), cputime (monotonic per
      // process — usable as a GENERATION floor but not identity),
      // launchctl procinfo (no creation timestamp), per-pid sysctl lookup
      // (not exposed by the macOS sysctl CLI). True sub-second creation
      // identity exists only behind libproc's proc_pidinfo — a native
      // binding, which is a dependency decision left open, not something
      // this code can assume. What IS deployable: bind every observable
      // dimension — pid, lstart, ppid, pgid, session id, a digest of the
      // full command line — plus a cputime floor captured at bind: a
      // same-second reused pid with the same parent, pgid, session and
      // byte-identical argv is still refused while its accumulated CPU
      // time is below the original's at bind (a fresh process starts near
      // zero). The residual window — same second, same parent/pgid/
      // session, identical argv AND already more CPU than the original had
      // at bind — remains open and documented, not claimed closed. Windows
      // CIM (sub-second CreationDate) and Linux /proc (clock-tick
      // starttime) both provide true creation identity.
      // -ww: ps truncates command output to the terminal width without
      // it, and a truncated command line changes the token digest between
      // observations of the SAME process — identity must be stable.
      const fields = execFileSync(
        "ps",
        ["-ww", "-p", String(pid), "-o", "lstart=,ppid=,pgid=,sess=,cputime=,command="],
        { encoding: "utf8", timeout: 3000 },
      );
      const parsed = parseMacosPs(fields);
      if (!parsed) return null;
      command = parsed.command;
      token = macosProcessToken(pid, parsed);
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

export interface MacosProcessFields {
  lstart: string;
  ppid: string;
  pgid: string;
  sess: string;
  /** Accumulated CPU time in centiseconds, parsed from cputime. */
  cpuCentis: number;
  command: string;
}

/**
 * Parse one `ps -o lstart=,ppid=,pgid=,sess=,cputime=,command=` record.
 * Returns null when any identity field is missing — an unreadable field
 * means unverifiable identity, and the callers refuse to act on it.
 * cputime prints as [HH:]MM:SS.cc, centiseconds always last two digits.
 */
export function parseMacosPs(record: string): MacosProcessFields | null {
  const lstart = record.slice(0, 24).trim();
  const rest = record.slice(24).trimStart().split(/\s+/);
  const [ppid, pgid, sess, cputime] = rest;
  const command = rest.slice(4).join(" ");
  if (!lstart || !ppid || !pgid || !sess || !cputime || !command) return null;
  // cputime prints as [HH:]MM:SS.cc — convert the whole duration to
  // centiseconds so the floor comparison is monotonic across magnitudes.
  const segments = cputime.split(":").map(Number);
  if (segments.some((n) => !Number.isFinite(n))) return null;
  // [HH:]MM:SS.cc — fold left so each leading segment is one sexagesimal
  // place: "1:02:03.50" → 3723.5 s, "0:04.15" → 4.15 s.
  const seconds = segments.reduce((acc, segment) => acc * 60 + segment, 0);
  const cpuCentis = Math.round(seconds * 100);
  return { lstart, ppid, pgid, sess, cpuCentis, command };
}

/**
 * macOS process token: pid + every ps-observable identity dimension + a
 * cputime floor captured at bind time. See the inspector's macOS branch
 * for the precision boundary and the residual reuse window this documents.
 * Exported for regression coverage of the collision properties.
 */
export function macosProcessToken(pid: number, fields: MacosProcessFields): string {
  const commandDigest = createHash("sha256").update(fields.command).digest("hex").slice(0, 16);
  return [
    "macos",
    pid,
    fields.lstart,
    fields.ppid,
    fields.pgid,
    fields.sess,
    commandDigest,
    "cpu>=" + fields.cpuCentis,
  ].join(":");
}

/**
 * Three-way relation between a stored process token and a fresh inspection:
 *
 *  - "same":      the very same process generation (all fields equal, CPU
 *                 floor satisfied on macOS).
 *  - "replaced":  CONFIRMED different process generation — the creation
 *                 identity itself differs (macOS: different lstart second,
 *                 or a CPU floor violation, which only a fresh process can
 *                 produce; Windows/Linux tokens are pure creation stamps,
 *                 so any mismatch is a replacement).
 *  - "changed":   the creation identity still fits (same lstart, CPU floor
 *                 satisfied) but MUTABLE descriptor fields differ — the
 *                 same LIVE process was re-parented, changed its process
 *                 group/session, or rewrote its argv/title. This is NOT an
 *                 exit: marking such a row ended would let it be resumed
 *                 while the original process still runs.
 */
export type ProcessTokenRelation = "same" | "replaced" | "changed" | "unknown";

export function classifyProcessToken(stored: string, current: string): ProcessTokenRelation {
  if (stored === current) return "same";
  const a = parseMacosToken(stored) ?? null;
  const b = parseMacosToken(current) ?? null;
  if (a && b) return classifyCurrentFormat(a, b);
  // A token stored by an older build (pre-generation format: pid, lstart,
  // ppid, argv digest — no process group, session or CPU floor) cannot be
  // confirmed against the richer current inspection on its own terms.
  // Judging the LIVE process "replaced" from that mismatch would end the
  // row and allow a resume next to a still-running original — so an
  // unconfirmable legacy token is "unknown": stop and resume refuse until
  // a fresh bind re-stores the current-format token.
  const legacyStored = parseLegacyMacosToken(stored);
  const currentFormat = b ?? parseLegacyMacosToken(current);
  if (legacyStored && currentFormat) {
    const matchesLegacy =
      legacyStored.pid === currentFormat.pid &&
      legacyStored.lstart === currentFormat.lstart &&
      legacyStored.ppid === currentFormat.ppid &&
      legacyStored.digest === currentFormat.digest;
    if (matchesLegacy) return "same";
    if (legacyStored.pid !== currentFormat.pid) return "replaced";
    if (legacyStored.lstart !== currentFormat.lstart) return "replaced";
    return "unknown";
  }
  return "replaced";
}

function classifyCurrentFormat(
  a: NonNullable<ReturnType<typeof parseMacosToken>>,
  b: NonNullable<ReturnType<typeof parseMacosToken>>,
): ProcessTokenRelation {
  // The pid is embedded in the token itself: a different stored-vs-current
  // pid means the stored identity names a DIFFERENT process (the row was
  // re-pointed at another pid) — provably replaced, never "changed".
  if (a.pid !== b.pid) return "replaced";
  // Creation identity differs, or the live process has LESS accumulated
  // CPU than the stored floor — only a fresh process can do that.
  if (a.lstart !== b.lstart || !Number.isFinite(b.cpuCentis)) return "replaced";
  if (b.cpuCentis < a.cpuCentis) return "replaced";
  // Same generation. Equal descriptors (only the CPU floor grew) are the
  // same process; a differing descriptor field means the live process
  // mutated (re-parenting, setpgrp, rewritten argv/title).
  const staticsEqual =
    a.pid === b.pid &&
    a.ppid === b.ppid &&
    a.pgid === b.pgid &&
    a.sess === b.sess &&
    a.digest === b.digest;
  return staticsEqual ? "same" : "changed";
}

/**
 * The pre-generation macOS token format stored by earlier builds:
 * "<pid>:<lstart…>:<ppid>:<argvDigest16>". lstart contains colons, so the
 * layout parses from both ends (first = pid, last = digest, second-to-last
 * = ppid, middle = lstart). Returns null for anything else.
 */
export function parseLegacyMacosToken(token: string): {
  pid: string;
  lstart: string;
  ppid: string;
  digest: string;
} | null {
  const parts = token.split(":");
  if (parts[0] === "macos" || parts.length < 4) return null;
  const digest = parts.at(-1) ?? "";
  const ppid = parts.at(-2) ?? "";
  const pid = parts[0];
  const lstart = parts.slice(1, -2).join(":");
  if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid) || !/^[0-9a-f]{16}$/.test(digest)) return null;
  if (!/[A-Z][a-z]{2} /.test(lstart)) return null;
  return { pid, lstart, ppid, digest };
}

/**
 * Parse a macOS token back into its fields. lstart itself contains colons
 * ("Mon Nov  2 03:25:13 2026"), so the layout is anchored from both ends:
 * "macos:<pid>:<lstart…>:<ppid>:<pgid>:<sess>:<digest16>:cpu>=<N>" —
 * everything between the pid and the last five segments is the lstart.
 * Returns null for tokens in any other shape (non-macOS platforms).
 */
function parseMacosToken(token: string): {
  pid: string;
  lstart: string;
  ppid: string;
  pgid: string;
  sess: string;
  digest: string;
  cpuCentis: number;
} | null {
  const parts = token.split(":");
  if (parts[0] !== "macos" || parts.length < 8) return null;
  const floor = parts.at(-1) ?? "";
  if (!floor.startsWith("cpu>=")) return null;
  const cpuCentis = Number(floor.slice(5));
  if (!Number.isFinite(cpuCentis)) return null;
  const digest = parts.at(-2) ?? "";
  const sess = parts.at(-3) ?? "";
  const pgid = parts.at(-4) ?? "";
  const ppid = parts.at(-5) ?? "";
  const pid = parts[1];
  const lstart = parts.slice(2, -5).join(":");
  if (!pid || !lstart || !ppid || !pgid || !sess || !digest) return null;
  return { pid, lstart, ppid, pgid, sess, digest, cpuCentis };
}

/** Back-compat boolean view: only "same" counts as a match. */
function processTokenMatches(stored: string, current: string): boolean {
  return classifyProcessToken(stored, current) === "same";
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
