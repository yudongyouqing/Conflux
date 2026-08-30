import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";

export type Scope = "project" | "global";

export interface Config {
  /** Root directory that contains data.db (and WAL/SHM siblings). */
  dataDir: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Effective scope used to resolve dataDir. */
  scope: Scope;
}

/**
 * Resolve the muiltchat data directory.
 *
 * Precedence (highest first):
 *   1. Explicit `override` argument
 *   2. `MUILTCHAT_HOME` env var (when set & non-empty)
 *   3. `$CLAUDE_PROJECT_DIR/.muiltchat` — only when scope === "project"
 *      AND that directory already exists OR cwd contains a `.muiltchat`
 *      marker (avoids accidentally creating project-scoped dirs in random cwds).
 *   3. `~/.muiltchat` (global default)
 *
 * `scope` overrides detection: `--scope global` forces the home dir even when
 * `CLAUDE_PROJECT_DIR` is set.
 */
export function resolveConfig(scope: Scope = "global", override?: string): Config {
  const envHome = process.env.MUILTCHAT_HOME;
  if (override && override.trim().length > 0) {
    return finalize(resolve(override), detectScope(resolve(override)));
  }
  if (envHome && envHome.trim().length > 0) {
    return finalize(resolve(envHome), detectScope(resolve(envHome)));
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (scope === "project" && projectDir && projectDir.trim().length > 0) {
    const candidate = join(projectDir, ".muiltchat");
    return finalize(candidate, "project");
  }

  // Auto-detect: prefer an existing project-scoped dir under CLAUDE_PROJECT_DIR.
  if (projectDir && projectDir.trim().length > 0) {
    const candidate = join(projectDir, ".muiltchat");
    if (existsSync(candidate)) {
      return finalize(candidate, "project");
    }
  }

  const globalDir = join(homedir(), ".muiltchat");
  return finalize(globalDir, "global");
}

function detectScope(dir: string): Scope {
  // If the directory sits inside $CLAUDE_PROJECT_DIR/.muiltchat we treat it as project-scoped.
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir && dir === join(projectDir, ".muiltchat")) {
    return "project";
  }
  if (dir === join(homedir(), ".muiltchat")) {
    return "global";
  }
  return "global";
}

function finalize(dataDir: string, scope: Scope): Config {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return {
    dataDir,
    dbPath: join(dataDir, "data.db"),
    scope,
  };
}

/** Default HTTP server settings. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 9527;

export function resolveHttpHost(override?: string): string {
  const envHost = process.env.MUILTCHAT_HOST?.trim();
  return envHost || override || DEFAULT_HTTP_HOST;
}

export function resolveHttpPort(override?: number): number {
  const envPort = process.env.MUILTCHAT_PORT?.trim();
  if (!envPort) return override ?? DEFAULT_HTTP_PORT;

  const port = Number(envPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid MUILTCHAT_PORT: ${envPort}`);
  }
  return port;
}

/** Heartbeat staleness threshold in ms (2 minutes; MCP processes beat every 30s). */
export const STALE_AFTER_MS = 2 * 60 * 1000;

/** Default list/query limits. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
