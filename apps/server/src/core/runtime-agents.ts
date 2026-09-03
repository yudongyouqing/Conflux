import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { STALE_AFTER_MS } from "../config.js";
import { logger } from "../log.js";
import type { RuntimeAgent, RuntimeId } from "@muiltchat/shared";
import { cleanTerminalEnv, cmdQuote, HEADLESS_ALLOWED_TOOLS, idleWakeCommand, openInTerminal, wakeCommand } from "./terminal.js";
import { getAutoWake, getSetting, getTerminalSettings, setSetting } from "./app-settings.js";
import { getSession } from "./sessions.js";
import { hasTranscript } from "./live.js";

// moved to terminal.ts; re-exported for existing importers
export { cleanTerminalEnv } from "./terminal.js";

// ---- runtime catalog (AgentRecall-style: static definitions per CLI) ------

export const RUNTIMES: Record<
  RuntimeId,
  { label: string; executable: string; executableEnv: string }
> = {
  claude: { label: "Claude Code", executable: "claude", executableEnv: "CLAUDE_PATH" },
  codex: { label: "Codex", executable: "codex", executableEnv: "CODEX_PATH" },
};

export function isRuntimeId(v: unknown): v is RuntimeId {
  return v === "claude" || v === "codex";
}

interface RuntimeAgentRow {
  id: number;
  name: string;
  runtime: string;
  workdir: string | null;
  model: string | null;
  base_url: string | null;
  api_key: string | null;
  extra_env: string | null;
  instructions: string | null;
  interval_min: number | null;
  last_scheduled_run: string | null;
  created_at: string;
  updated_at: string;
}

function toAgent(row: RuntimeAgentRow): RuntimeAgent {
  return { ...row, runtime: row.runtime as RuntimeId };
}

export function createRuntimeAgent(
  db: DB,
  input: {
    name: string;
    runtime: string;
    workdir?: string | null;
    model?: string | null;
    base_url?: string | null;
    api_key?: string | null;
    extra_env?: string | null;
    instructions?: string | null;
    interval_min?: number | null;
  }
): RuntimeAgent {
  if (!input.name?.trim()) throw new Error("name is required");
  if (!isRuntimeId(input.runtime)) {
    throw new Error(`unknown runtime: ${input.runtime} (expected claude | codex)`);
  }
  if (input.extra_env) {
    try {
      const parsed = JSON.parse(input.extra_env);
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
        throw new Error("not an object");
      }
    } catch {
      throw new Error("extra_env must be a JSON object, e.g. {\"FOO\":\"bar\"}");
    }
  }
  const interval =
    input.interval_min === undefined || input.interval_min === null
      ? null
      : Math.floor(input.interval_min);
  if (interval !== null && (interval < 1 || interval > 10080)) {
    throw new Error("interval_min must be 1..10080 minutes (a week)");
  }
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO runtime_agents (name, runtime, workdir, model, base_url, api_key, extra_env, instructions, interval_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name.trim(),
      input.runtime,
      input.workdir?.trim() || null,
      input.model?.trim() || null,
      input.base_url?.trim() || null,
      input.api_key?.trim() || null,
      input.extra_env?.trim() || null,
      input.instructions?.trim() || null,
      interval,
      now,
      now
    );
  return getRuntimeAgent(db, Number(res.lastInsertRowid))!;
}

export function getRuntimeAgent(db: DB, id: number): RuntimeAgent | null {
  const row = db
    .prepare(`SELECT * FROM runtime_agents WHERE id = ?`)
    .get(id) as RuntimeAgentRow | undefined;
  return row ? toAgent(row) : null;
}

export function listRuntimeAgents(db: DB): RuntimeAgent[] {
  return (db
    .prepare(`SELECT * FROM runtime_agents ORDER BY updated_at DESC`)
    .all() as RuntimeAgentRow[]).map(toAgent);
}

/**
 * Annotate presets with liveness derived from their spawned sessions:
 * a preset is live iff at least one session tagged agent_id=<preset> has a
 * heartbeat newer than STALE_AFTER_MS. Sessions are matched by parsing
 * metadata in JS (LIKE '%agent_id":N%' alone would also match 10N/100N).
 */
export function listRuntimeAgentsWithLiveness(db: DB): RuntimeAgent[] {
  const threshold = Date.now() - STALE_AFTER_MS;
  const tagged = db
    .prepare(
      `SELECT id, last_heartbeat_at, metadata FROM sessions WHERE metadata LIKE '%"agent_id":%'`
    )
    .all() as { id: string; last_heartbeat_at: string; metadata: string | null }[];
  const byPreset = new Map<number, string[]>(); // preset id -> heartbeats
  for (const row of tagged) {
    try {
      const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      if (typeof meta.agent_id === "number") {
        const list = byPreset.get(meta.agent_id) ?? [];
        list.push(row.last_heartbeat_at);
        byPreset.set(meta.agent_id, list);
      }
    } catch {
      // malformed metadata — skip
    }
  }
  return listRuntimeAgents(db).map((a) => {
    const beats = (byPreset.get(a.id) ?? []).sort();
    const lastSeen = beats[beats.length - 1] ?? null;
    return {
      ...a,
      last_seen: lastSeen,
      live: !!lastSeen && new Date(lastSeen).getTime() > threshold,
    };
  });
}

export function deleteRuntimeAgent(db: DB, id: number): boolean {
  const res = db.prepare(`DELETE FROM runtime_agents WHERE id = ?`).run(id);
  return res.changes > 0;
}

// ---- environment construction ----------------------------------------------

/**
 * Build the process environment for a runtime agent. Inherited credentials
 * are only removed when the preset REPLACES them (its own api_key/base_url) —
 * otherwise the spawned CLI keeps whatever auth the user's environment
 * already carries (AgentRecall's claude-env substitutes per channel the same
 * way). MUILTCHAT_AGENT_ID lets the spawned agent's hooks / MCP tag its
 * session row back to this definition.
 */
export function buildRuntimeEnv(
  agent: Pick<RuntimeAgent, "runtime" | "base_url" | "api_key" | "model" | "extra_env" | "id">,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  if (agent.runtime === "claude") {
    if (agent.api_key) {
      delete env.ANTHROPIC_API_KEY; // replaced, not inherited
      env.ANTHROPIC_AUTH_TOKEN = agent.api_key;
    }
    if (agent.base_url) env.ANTHROPIC_BASE_URL = agent.base_url;
    if (agent.model) env.ANTHROPIC_MODEL = agent.model;
  } else {
    if (agent.api_key) env.OPENAI_API_KEY = agent.api_key;
    if (agent.base_url) env.OPENAI_BASE_URL = agent.base_url;
  }

  if (agent.extra_env) {
    try {
      const extra = JSON.parse(agent.extra_env) as Record<string, string>;
      for (const [k, v] of Object.entries(extra)) env[k] = String(v);
    } catch {
      // validated at create time; ignore malformed rows
    }
  }

  env.MUILTCHAT_AGENT_ID = String(agent.id);
  env.MUILTCHAT_AGENT_RUNTIME = agent.runtime;
  return env;
}

/**
 * Always appended to spawned claude runtime agents: turns the terminal
 * session into an active muiltchat responder instead of a passive mailbox.
 * User instructions (if any) come after it.
 */
export const RUNTIME_OPERATOR_PROMPT = [
  "你是 muiltchat 网络的常驻应答会话。",
  "每次被唤起时,先调用 muiltchat 的 check_inbox 工具:如有其他会话的问题,认真处理后用 reply_ask 回复;",
  "处理过程中发现值得共享的结论,用 publish_context 发布。",
  "没有待办时保持安静、简短,不要输出无关内容。",
].join("");

/** CLI arguments for the runtime (model / system prompt presets). */
export function buildRuntimeArgs(agent: Pick<RuntimeAgent, "runtime" | "model" | "instructions">): string[] {
  if (agent.runtime === "claude") {
    const args: string[] = [];
    if (agent.model) args.push("--model", agent.model);
    // Operator prompt is unconditional; user instructions extend it.
    const systemPrompt = agent.instructions?.trim()
      ? `${RUNTIME_OPERATOR_PROMPT}\n\n${agent.instructions.trim()}`
      : RUNTIME_OPERATOR_PROMPT;
    args.push("--append-system-prompt", systemPrompt);
    return args;
  }
  // codex: no append-system-prompt equivalent on the CLI — model only
  const args: string[] = [];
  if (agent.model) args.push("--model", agent.model);
  return args;
}

/**
 * Launch the agent's CLI in a NEW terminal window with the preset env and
 * working directory. The window is owned by the user's terminal host (per
 * the terminal opener setting), not by the serve process — serve only
 * triggers it. On non-Windows platforms we refuse rather than fake support
 * (spawn-in-current-terminal needs a TTY we don't have).
 */
export function startRuntimeAgent(
  db: DB,
  id: number,
  opts: { platform?: NodeJS.Platform; comspec?: string } = {}
): { started: true } {
  const agent = getRuntimeAgent(db, id);
  if (!agent) throw new Error(`runtime agent not found: ${id}`);

  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error("starting a runtime agent needs Windows (wt/cmd) or macOS (Terminal.app/iTerm2/tmux)");
  }
  if (agent.workdir && !existsSync(agent.workdir)) {
    throw new Error(`workdir does not exist: ${agent.workdir}`);
  }

  const settings = getTerminalSettings(db);
  const def = RUNTIMES[agent.runtime];
  const defaultExe =
    agent.runtime === "claude" ? settings.claude_path : settings.codex_path;
  const executable = process.env[def.executableEnv] || defaultExe;
  const args = buildRuntimeArgs(agent);
  const command = [cmdQuote(executable), ...args.map(cmdQuote)].join(" ");

  openInTerminal(
    settings,
    {
      command,
      cwd: agent.workdir || undefined,
      title: `muiltchat · ${agent.name}`,
      env: buildRuntimeEnv(agent, cleanTerminalEnv()),
    },
    opts
  );
  logger.info({ agentId: id, runtime: agent.runtime, name: agent.name }, "runtime agent launched");
  return { started: true };
}

// ---- scheduled headless runs (patrol pattern) --------------------------------

/** Wake-up prompt for scheduled runs; the operator system prompt does the rest. */
export const SCHEDULED_WAKE_PROMPT = "定时唤醒:请按系统指令检查并处理收件箱,然后简短结束。";

/** Args for a one-shot headless run (claude -p / codex exec). */
export function buildHeadlessArgs(
  agent: Pick<RuntimeAgent, "runtime" | "model" | "instructions">,
  prompt: string = SCHEDULED_WAKE_PROMPT
): string[] {
  if (agent.runtime === "codex") {
    return ["exec", ...(agent.model ? ["--model", agent.model] : []), "--", prompt];
  }
  // headless runs cannot answer permission prompts — pre-authorize muiltchat tools
  return [...buildRuntimeArgs(agent), "--allowedTools", HEADLESS_ALLOWED_TOOLS, "-p", prompt];
}

/** Is a spawned instance of this preset still alive? (skip overlapping runs) */
export function hasActiveRun(db: DB, agentId: number): boolean {
  const rows = db
    .prepare(
      `SELECT id, metadata FROM sessions
       WHERE status = 'active' AND metadata LIKE ?`
    )
    .all(`%"agent_id":${agentId},%`) as { id: string; metadata: string | null }[];
  return rows.some((r) => {
    try {
      return JSON.parse(r.metadata ?? "{}").agent_id === agentId;
    } catch {
      return false;
    }
  });
}

/** Due when an interval is set and it elapsed since the last scheduled run. */
export function isDue(
  agent: Pick<RuntimeAgent, "interval_min" | "last_scheduled_run">,
  now: Date = new Date()
): boolean {
  if (!agent.interval_min || agent.interval_min < 1) return false;
  if (!agent.last_scheduled_run) return true;
  return now.getTime() - Date.parse(agent.last_scheduled_run) >= agent.interval_min * 60_000;
}

/**
 * Launch one scheduled run: headless (no terminal window), detached, with the
 * preset env. The run registers as a normal session via hooks, handles its
 * inbox per the operator prompt, and exits. Output is discarded — the session
 * row and any reply_ask results are the observable outcome.
 */
export function runScheduledAgent(
  db: DB,
  id: number,
  opts: { platform?: NodeJS.Platform } = {}
): { launched: true } {
  const agent = getRuntimeAgent(db, id);
  if (!agent) throw new Error(`runtime agent not found: ${id}`);
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`unsupported platform: ${platform}`);
  }
  if (agent.workdir && !existsSync(agent.workdir)) {
    throw new Error(`workdir does not exist: ${agent.workdir}`);
  }

  const settings = getTerminalSettings(db);
  const def = RUNTIMES[agent.runtime];
  const defaultExe = agent.runtime === "claude" ? settings.claude_path : settings.codex_path;
  const executable = process.env[def.executableEnv] || defaultExe;
  const parts = [cmdQuote(executable), ...buildHeadlessArgs(agent).map(cmdQuote)];
  const command = parts.join(" ");

  const env = buildRuntimeEnv(agent, cleanTerminalEnv());
  const child = spawn(process.env.comspec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    // NOT detached: DETACHED_PROCESS children die silently with the spawner
    // on Windows. windowsHide gives the child its own invisible console —
    // proven working for headless claude runs.
    detached: process.platform !== "win32",
    stdio: "ignore",
    env,
    cwd: agent.workdir || undefined,
    windowsVerbatimArguments: process.platform === "win32",
    windowsHide: true,
  });
  child.unref();

  db.prepare(`UPDATE runtime_agents SET last_scheduled_run = ? WHERE id = ?`).run(
    nowIso(),
    id
  );
  logger.info({ agentId: id, name: agent.name }, "scheduled runtime agent run launched");
  return { launched: true };
}

/**
 * Scheduler tick: launch every due, non-overlapping scheduled agent.
 * The launcher is injectable for tests.
 */
export function tickScheduledAgents(
  db: DB,
  launcher: (db: DB, id: number) => unknown = runScheduledAgent
): number {
  let launched = 0;
  for (const agent of listRuntimeAgents(db)) {
    if (!isDue(agent) || hasActiveRun(db, agent.id)) continue;
    try {
      launcher(db, agent.id);
      launched++;
    } catch (err) {
      logger.warn(
        { agentId: agent.id, err: err instanceof Error ? err.message : String(err) },
        "scheduled run failed"
      );
    }
  }
  return launched;
}

// ---- auto-answer: wake an OFFLINE session when someone asks it --------------

/**
 * True auto-answer: a question sent to a session whose claude process is
 * gone would be a dead letter — instead, headlessly resume THAT
 * conversation with a wake prompt; the run checks its inbox and replies.
 * (The resume lineage forwarding re-addresses the pending mail to the run's
 * new conversation id, so the wake finds the question.)
 *
 * Skips: busy sessions (their turn surfaces the mail), web console,
 * internal agents, codex runtimes (no headless resume-with-prompt), and
 * repeats within DEDUP_MS. dryRun returns the command without spawning.
 */
const AUTO_WAKE_DEDUP_MS = 90_000;

function wakeExe(db: DB, runtime: "claude" | "codex"): string {
  const settings = getTerminalSettings(db);
  return runtime === "codex"
    ? process.env.CODEX_PATH || settings.codex_path
    : process.env.CLAUDE_PATH || settings.claude_path;
}

/** Dedup + spawn one headless wake run acting as the session's identity. */
function launchWake(
  db: DB,
  session: { id: string; project_dir: string | null },
  opts: { dryRun?: boolean; now?: Date },
  command: string
): { woke: true; command: string } | { woke: false; reason: string } {
  const now = (opts.now ?? new Date()).getTime();
  const last = getSetting(db, `auto-wake:${session.id}`);
  if (last && now - Date.parse(last) < AUTO_WAKE_DEDUP_MS) {
    return { woke: false, reason: "wake already in flight" };
  }
  if (opts.dryRun) return { woke: true, command };
  // Assume the target's identity: headless runs may not fire registering
  // hooks, so the run's MCP adopts the target session via env.
  const env = cleanTerminalEnv();
  env.MUILTCHAT_ASSUME_SESSION = session.id;
  const child = spawn(process.env.comspec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    env,
    cwd: session.project_dir ?? undefined,
    windowsVerbatimArguments: process.platform === "win32",
    windowsHide: true,
  });
  child.unref();
  setSetting(db, `auto-wake:${session.id}`, new Date(now).toISOString());
  logger.info({ sessionId: session.id }, "auto-wake launched");
  return { woke: true, command };
}

/**
 * Wake a session so it processes its inbox:
 *   - active + busy  → skip: the running turn will surface the mail itself
 *   - active + idle  → FRESH headless run adopting the session's identity.
 *     Never --resume here — the open TUI owns the transcript and a second
 *     writer could corrupt it. The waker answers from mail + project dir.
 *   - offline        → resume wake (the TUI is closed, the transcript is
 *     free to continue with full conversation context).
 */
export function wakeSessionForMail(
  db: DB,
  sessionId: string,
  opts: { dryRun?: boolean; now?: Date; claudeHome?: string } = {}
): { woke: true; command: string } | { woke: false; reason: string } {
  if (!getAutoWake(db)) return { woke: false, reason: "auto_wake disabled" };
  if (sessionId === "web-console" || sessionId.startsWith("agent-")) {
    return { woke: false, reason: "not a CLI conversation" };
  }
  const session = getSession(db, sessionId);
  if (!session) return { woke: false, reason: "session not found" };

  let runtime: "claude" | "codex" = "claude";
  let meta: Record<string, unknown> | null = null;
  try {
    meta = session.metadata ? (JSON.parse(session.metadata) as Record<string, unknown>) : null;
    if (meta?.runtime === "codex") runtime = "codex";
  } catch {
    // default runtime
  }

  if (session.status === "active") {
    if (meta?.busy === true) {
      return { woke: false, reason: "busy — the running turn will surface the mail" };
    }
    return launchWake(db, session, opts, idleWakeCommand(runtime, wakeExe(db, runtime)));
  }

  // Offline: resume the real conversation. Codex resumes by the uuid that
  // codex-titles stamped from its rollout; claude's uuid is the session id.
  const codexSessionId = typeof meta?.codex_session_id === "string" ? meta.codex_session_id : null;
  if (runtime === "codex" && !codexSessionId) {
    return { woke: false, reason: "no codex_session_id (rollout binding missing)" };
  }
  // `claude --resume` needs the transcript file — claude only writes it on
  // the first turn, so zero-turn conversations cannot be woken (they have
  // no context to answer from anyway).
  if (runtime === "claude" && !hasTranscript(sessionId, session.project_dir, opts.claudeHome)) {
    return { woke: false, reason: "no transcript (zero-turn conversation)" };
  }
  return launchWake(db, session, opts, wakeCommand(runtime, codexSessionId ?? sessionId, wakeExe(db, runtime)));
}
