/**
 * Declarative registry of every local coding agent Conflux can drive.
 *
 * Architecture borrowed from AgentRecall's migration-targets (the proven
 * insight there: runtime behavior derives from the agent's FAMILY, not its
 * id — resume flags, skip-permission flags and headless modes repeat across
 * forks). Registering a new agent = adding one descriptor here; everything
 * downstream (terminal presets, resume commands, scheduled runs, env
 * binding) is family-driven.
 *
 * Liveness probing and mail wake stay claude|codex only (those are the two
 * runtimes with MCP integration); other agents work as launchable presets
 * with session stores readable by codex-titles-style IO in the future.
 */

export type RuntimeFamily = "claude" | "codex" | "other";

export interface RuntimeDescriptor {
  /** preset id persisted in runtime_agents.runtime */
  id: string;
  label: string;
  /** behavior family: drives resume args, env binding, headless shape */
  family: RuntimeFamily;
  /** default binary name resolved on PATH */
  executable: string;
  /** env var overriding the executable (e.g. CLAUDE_PATH) */
  executableEnv: string;
  /** optional terminal-settings key holding a configured binary path */
  settingsKey?: "claude_path" | "codex_path";
  /** resume args appended after the binary (AgentRecall-validated shapes) */
  resumeArgs: (sessionId: string) => string[];
  /** headless one-shot args; null = no known headless mode (interactive only) */
  headlessArgs: ((prompt: string) => string[]) | null;
  /** API env flavor for base_url/api_key preset fields */
  envBinding: "anthropic" | "openai" | null;
  /** home dir of the agent's native session store (future readers) */
  sessionHome: string;
  /** process-identity tokens for liveness (claude/codex only today) */
  wakeCapable: boolean;
}

const home = () => process.env.USERPROFILE || process.env.HOME || ".";

export const RUNTIME_REGISTRY: Record<string, RuntimeDescriptor> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    family: "claude",
    executable: "claude",
    executableEnv: "CLAUDE_PATH",
    settingsKey: "claude_path",
    resumeArgs: (id) => ["--resume", id],
    headlessArgs: (prompt) => ["-p", prompt],
    envBinding: "anthropic",
    sessionHome: `${home()}/.claude`,
    wakeCapable: true,
  },
  codex: {
    id: "codex",
    label: "Codex",
    family: "codex",
    executable: "codex",
    executableEnv: "CODEX_PATH",
    settingsKey: "codex_path",
    resumeArgs: (id) => ["resume", id],
    headlessArgs: (prompt) => ["exec", "--", prompt],
    envBinding: "openai",
    sessionHome: `${home()}/.codex`,
    wakeCapable: true,
  },
  // ---- any-local-agent tier (launchable presets; no wake/liveness yet) ----
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    family: "other",
    executable: "cursor-agent",
    executableEnv: "CURSOR_AGENT_PATH",
    resumeArgs: (id) => ["--resume", id],
    headlessArgs: null,
    envBinding: null,
    sessionHome: `${home()}/.cursor`,
    wakeCapable: false,
  },
  codebuddy: {
    id: "codebuddy",
    label: "CodeBuddy",
    family: "claude", // claude-format session store (per AgentRecall loaders)
    executable: "codebuddy",
    executableEnv: "CODEBUDDY_PATH",
    resumeArgs: (id) => ["--resume", id],
    headlessArgs: null,
    envBinding: null,
    sessionHome: `${home()}/.codebuddy`,
    wakeCapable: false,
  },
  codewiz: {
    id: "codewiz",
    label: "CodeWiz",
    family: "other",
    executable: "codewiz",
    executableEnv: "CODEWIZ_PATH",
    resumeArgs: (id) => ["--session", id], // AgentRecall-validated shape
    headlessArgs: null,
    envBinding: null,
    sessionHome: `${home()}/.local/share/codewiz`,
    wakeCapable: false,
  },
};

export const RUNTIME_IDS = Object.keys(RUNTIME_REGISTRY);

export function isPresetRuntime(v: unknown): v is string {
  return typeof v === "string" && Object.hasOwn(RUNTIME_REGISTRY, v);
}

export function runtimeDescriptor(id: string): RuntimeDescriptor {
  const def = RUNTIME_REGISTRY[id];
  if (!def) throw new Error(`unknown runtime: ${id}`);
  return def;
}
