import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeId, RuntimeSettings } from "@conflux/shared";
import type { DB } from "./db.js";

const SETTINGS_KEY = "runtime_settings";

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  claude_path: "claude",
  codex_path: "codex",
  antigravity_path: "agy",
  acp_path: "",
  mica_path: "mica",
  max_autonomous_hops: 5,
  pair_cooldown_ms: 2000,
};

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getRuntimeSettings(db: DB): RuntimeSettings {
  const raw = getSetting(db, SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_RUNTIME_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
    return {
      claude_path: parsed.claude_path?.trim() || DEFAULT_RUNTIME_SETTINGS.claude_path,
      codex_path: parsed.codex_path?.trim() || DEFAULT_RUNTIME_SETTINGS.codex_path,
      antigravity_path: parsed.antigravity_path?.trim() || DEFAULT_RUNTIME_SETTINGS.antigravity_path,
      acp_path: typeof parsed.acp_path === "string" ? parsed.acp_path.trim() : DEFAULT_RUNTIME_SETTINGS.acp_path,
      mica_path: parsed.mica_path?.trim() || DEFAULT_RUNTIME_SETTINGS.mica_path,
      max_autonomous_hops:
        typeof parsed.max_autonomous_hops === "number" &&
        Number.isInteger(parsed.max_autonomous_hops) &&
        parsed.max_autonomous_hops >= 1 &&
        parsed.max_autonomous_hops <= 20
          ? parsed.max_autonomous_hops
          : DEFAULT_RUNTIME_SETTINGS.max_autonomous_hops,
      pair_cooldown_ms:
        typeof parsed.pair_cooldown_ms === "number" &&
        Number.isFinite(parsed.pair_cooldown_ms) &&
        parsed.pair_cooldown_ms >= 0 &&
        parsed.pair_cooldown_ms <= 60_000
          ? Math.floor(parsed.pair_cooldown_ms)
          : DEFAULT_RUNTIME_SETTINGS.pair_cooldown_ms,
    };
  } catch {
    return { ...DEFAULT_RUNTIME_SETTINGS };
  }
}

export function saveRuntimeSettings(
  db: DB,
  patch: Partial<RuntimeSettings>,
): RuntimeSettings {
  const cur = getRuntimeSettings(db);
  const next: RuntimeSettings = {
    claude_path:
      typeof patch.claude_path === "string"
        ? patch.claude_path.trim() || DEFAULT_RUNTIME_SETTINGS.claude_path
        : cur.claude_path,
    codex_path:
      typeof patch.codex_path === "string"
        ? patch.codex_path.trim() || DEFAULT_RUNTIME_SETTINGS.codex_path
        : cur.codex_path,
    antigravity_path:
      typeof patch.antigravity_path === "string"
        ? patch.antigravity_path.trim() || DEFAULT_RUNTIME_SETTINGS.antigravity_path
        : cur.antigravity_path,
    acp_path:
      typeof patch.acp_path === "string"
        ? patch.acp_path.trim()
        : cur.acp_path,
    mica_path:
      typeof patch.mica_path === "string"
        ? patch.mica_path.trim() || DEFAULT_RUNTIME_SETTINGS.mica_path
        : cur.mica_path,
    max_autonomous_hops:
      typeof patch.max_autonomous_hops === "number" &&
      Number.isInteger(patch.max_autonomous_hops) &&
      patch.max_autonomous_hops >= 1 &&
      patch.max_autonomous_hops <= 20
        ? patch.max_autonomous_hops
        : cur.max_autonomous_hops,
    pair_cooldown_ms:
      typeof patch.pair_cooldown_ms === "number" &&
      Number.isFinite(patch.pair_cooldown_ms) &&
      patch.pair_cooldown_ms >= 0 &&
      patch.pair_cooldown_ms <= 60_000
        ? Math.floor(patch.pair_cooldown_ms)
        : cur.pair_cooldown_ms,
  };
  setSetting(db, SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function resolveRuntimeExecutable(db: DB, runtime: RuntimeId): string {
  const settings = getRuntimeSettings(db);
  switch (runtime) {
    case "claude":
      return process.env.CLAUDE_PATH || settings.claude_path || "claude";
    case "codex":
      return process.env.CODEX_PATH || settings.codex_path || "codex";
    case "antigravity":
      return process.env.ANTIGRAVITY_PATH || settings.antigravity_path || "agy";
    case "acp": {
      const custom = process.env.ACP_AGENT_PATH?.trim() || settings.acp_path.trim();
      if (!custom) {
        throw Object.assign(new Error("请先在设置中配置自定义 ACP CLI 路径，或直接使用 Antigravity (agy)"), {
          statusCode: 400,
        });
      }
      return custom;
    }
  }
}

/** Resolve the Mica CLI to invoke; env override wins so tests can pin a shim. */
export function resolveMicaExecutable(db: DB): string {
  const settings = getRuntimeSettings(db);
  return process.env.MICA_PATH?.trim() || settings.mica_path || "mica";
}

/** Strip host-specific vars that cause nested CLI collisions (e.g. CLAUDECODE). */
export function cleanSpawnEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export interface ThreadLaunchSpec {
  id: string;
  name: string;
  runtime: RuntimeId;
  workdir: string;
  model: string | null;
  instructions: string | null;
  extra_env: string | null;
}

export function buildThreadEnv(
  spec: ThreadLaunchSpec,
  baseEnv: NodeJS.ProcessEnv = cleanSpawnEnv(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (spec.extra_env) {
    try {
      const parsed = JSON.parse(spec.extra_env) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") env[k] = v;
        }
      }
    } catch {
      // ignore malformed extra_env JSON
    }
  }
  env.CONFLUX_SESSION_ID = spec.id;
  env.CONFLUX_THREAD_ID = spec.id;
  env.CONFLUX_AGENT_RUNTIME = spec.runtime;
  return env;
}

function defaultServerEntry(): string {
  const distEntry = resolve(__dirname, "../index.js");
  if (existsSync(distEntry)) return distEntry;
  return resolve(__dirname, "../index.ts");
}

/** Build a pinned MCP server launch command bound strictly to one Conflux dataDir. */
export function pinnedMcpLaunch(dataDir: string): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const entry = defaultServerEntry();
  return {
    command: process.execPath,
    args: [
      ...(entry.endsWith(".ts") ? ["--import", pathToFileURL(require.resolve("tsx")).href] : []),
      entry,
      "--data-dir",
      dataDir,
      "mcp",
    ],
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
  };
}

/** Write an idempotent Claude `--mcp-config` file bound to this server's database. */
export function ensureClaudeMcpConfig(
  dataDir: string,
  threadId?: string,
  launch = pinnedMcpLaunch(dataDir),
): string {
  mkdirSync(dataDir, { recursive: true });
  const suffix = threadId ? `-${threadId.slice(0, 8)}` : "";
  const filePath = join(dataDir, `managed-mcp${suffix}.json`);
  const env = {
    ...(launch.env ?? {}),
    CONFLUX_HOME: dataDir,
    ...(threadId ? { CONFLUX_SESSION_ID: threadId, CONFLUX_THREAD_ID: threadId } : {}),
  };
  writeFileSync(
    filePath,
    JSON.stringify({
      mcpServers: {
        conflux: {
          command: launch.command,
          args: launch.args,
          env,
        },
      },
    }),
    "utf8",
  );
  return filePath;
}

/** Build Codex `-c` overrides pinning the mounted Conflux MCP server to this database. */
export function buildCodexManagedMcpArgs(env: NodeJS.ProcessEnv, db: DB): string[] {
  if (!db.name || db.name === ":memory:") return [];
  const dataDir = dirname(db.name);
  const literal = (value: string) => (value.includes("'") ? `'''${value}'''` : `'${value}'`);
  const launch = pinnedMcpLaunch(dataDir);
  const args: string[] = [
    "-c",
    `mcp_servers.conflux.command=${literal(launch.command)}`,
    "-c",
    `mcp_servers.conflux.args=[${launch.args.map(literal).join(",")}]`,
    "-c",
    `mcp_servers.conflux.env.CONFLUX_HOME=${literal(dataDir)}`,
  ];
  for (const key of ["CONFLUX_SESSION_ID", "CONFLUX_THREAD_ID", "CONFLUX_AGENT_RUNTIME"]) {
    if (env[key]) {
      args.push("-c", `mcp_servers.conflux.env.${key}=${literal(env[key]!)}`);
    }
  }
  if (process.versions.electron) {
    args.push("-c", "mcp_servers.conflux.env.ELECTRON_RUN_AS_NODE='1'");
  }
  return args;
}
