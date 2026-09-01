import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import { resolveDataHome } from "./core/config-migration.js";

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
 * Resolve the shared Conflux/muiltchat data directory.
 *
 * Precedence (highest first):
 *   1. Explicit `override` argument
 *   2. `CONFLUX_HOME` env var (when set & non-empty)
 *   3. `MUILTCHAT_HOME` env var (when set & non-empty)
 *   4. an existing project-scoped `.muiltchat` directory
 *   5. `~/.muiltchat` (global default)
 *
 * `scope` overrides detection: `--scope global` forces the home dir even when
 * `CLAUDE_PROJECT_DIR` is set.
 */
export function resolveConfig(scope: Scope = "global", override?: string): Config {
  const dataDir = resolveDataHome({
    override,
    scope,
    env: process.env,
  });
  return finalize(dataDir, detectScope(dataDir));
}

function detectScope(dir: string): Scope {
  // If the directory sits inside $CLAUDE_PROJECT_DIR/.muiltchat we treat it as project-scoped.
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir && dir === resolve(join(projectDir, ".muiltchat"))) {
    return "project";
  }
  if (dir === resolve(join(homedir(), ".muiltchat"))) {
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
