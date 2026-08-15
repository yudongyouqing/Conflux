import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { logger } from "../log.js";
import type { RuntimeAgent, RuntimeId } from "@muiltchat/shared";

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
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO runtime_agents (name, runtime, workdir, model, base_url, api_key, extra_env, instructions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
 * Minimal clean environment for a spawned agent terminal. The serve process
 * may carry session-scoped vars of the Claude Code session that started it
 * (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, its auth token and model overrides) —
 * leaking those into a fresh agent both breaks it and confuses identities.
 * So we whitelist the OS/user essentials instead of inheriting, then apply
 * the preset channel on top via buildRuntimeEnv.
 */
export function cleanTerminalEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "ComSpec",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "USERPROFILE",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "windir",
    "LANG",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) {
    const v = baseEnv[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** CLI arguments for the runtime (model / system prompt presets). */
export function buildRuntimeArgs(agent: Pick<RuntimeAgent, "runtime" | "model" | "instructions">): string[] {
  if (agent.runtime === "claude") {
    const args: string[] = [];
    if (agent.model) args.push("--model", agent.model);
    if (agent.instructions) args.push("--append-system-prompt", agent.instructions);
    return args;
  }
  // codex
  const args: string[] = [];
  if (agent.model) args.push("--model", agent.model);
  return args;
}

/**
 * Launch the agent's CLI in a NEW terminal window with the preset env and
 * working directory. The window is owned by the user's terminal host, not by
 * the serve process — serve only triggers it. On non-Windows platforms we
 * refuse rather than fake support (spawn-in-current-terminal needs a TTY we
 * don't have).
 */
export function startRuntimeAgent(
  db: DB,
  id: number,
  opts: { platform?: NodeJS.Platform; comspec?: string } = {}
): { started: true } {
  const agent = getRuntimeAgent(db, id);
  if (!agent) throw new Error(`runtime agent not found: ${id}`);

  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("starting a runtime agent is Windows-only for now (new terminal window)");
  }

  const def = RUNTIMES[agent.runtime];
  const executable = process.env[def.executableEnv] || def.executable;
  const args = buildRuntimeArgs(agent);
  const env = buildRuntimeEnv(agent, cleanTerminalEnv());

  if (agent.workdir && !existsSync(agent.workdir)) {
    throw new Error(`workdir does not exist: ${agent.workdir}`);
  }

  // `cmd /d /s /c start "<title>" [/D "<workdir>"] "<exe>" [args...]`
  // - npm-installed CLIs are .cmd shims, which only `start` (via cmd) resolves
  // - the new window inherits env from this cmd process
  // - windowsVerbatimArguments means WE do the quoting: quote every token that
  //   can contain spaces; start reads the first quoted token as window title
  // - NOT detached: a DETACHED_PROCESS cmd has no console and `start` fails
  //   silently in it. `start` already opens an independent window, and the
  //   wrapper cmd exits within milliseconds, so a sync spawn is fine.
  // - stdio MUST be "ignore": with pipes, the started child inherits the pipe
  //   handles and spawnSync blocks until the terminal closes.
  const cmdQuote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);
  const parts = ["start", cmdQuote(`muiltchat · ${agent.name}`)];
  if (agent.workdir) parts.push("/D", cmdQuote(agent.workdir));
  parts.push(cmdQuote(executable), ...args.map(cmdQuote));
  const command = parts.join(" ");

  const comspec = opts.comspec ?? process.env.comspec ?? "cmd.exe";
  const res = spawnSync(comspec, ["/d", "/s", "/c", command], {
    stdio: "ignore",
    timeout: 15_000,
    env,
    windowsVerbatimArguments: true,
  });
  if (res.error || res.status !== 0) {
    const detail = res.error?.message ?? `exit ${res.status}`;
    throw new Error(`failed to launch terminal: ${detail}`);
  }
  logger.info({ agentId: id, runtime: agent.runtime, name: agent.name }, "runtime agent launched");
  return { started: true };
}
