import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";

export type Scope = "project" | "global";

export interface Config {
  /** Root directory that contains conflux-v2.db (and WAL/SHM siblings). */
  dataDir: string;
  /** Absolute path to the v2 SQLite database file (physically isolated from v1 data.db). */
  dbPath: string;
  /** Effective scope used to resolve dataDir. */
  scope: Scope;
}

/**
 * Resolve the shared Conflux data directory without creating it:
 *   1. Explicit `override` argument
 *   2. `CONFLUX_HOME` env var
 *   3. Project-scoped `.muiltchat` (when scope !== "global")
 *   4. `~/.muiltchat` (global default)
 */
export function resolveDataHome(opts: {
  override?: string;
  scope?: Scope;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = opts.env ?? process.env;
  const explicit = opts.override?.trim();
  if (explicit) return resolve(explicit);

  const confluxHome = env.CONFLUX_HOME?.trim();
  if (confluxHome) return resolve(confluxHome);

  if (opts.scope !== "global") {
    const projectDir = env.CLAUDE_PROJECT_DIR?.trim();
    if (projectDir) {
      const projectHome = resolve(join(projectDir, ".muiltchat"));
      if (opts.scope === "project" || existsSync(projectHome)) return projectHome;
    }
  }

  return resolve(join(homedir(), ".muiltchat"));
}

export function resolveConfig(scope: Scope = "global", override?: string): Config {
  const dataDir = resolveDataHome({ override, scope });
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const effectiveScope: Scope =
    projectDir && dataDir === resolve(join(projectDir, ".muiltchat")) ? "project" : "global";
  return {
    dataDir,
    dbPath: join(dataDir, "conflux-v2.db"),
    scope: effectiveScope,
  };
}

/** Default HTTP server settings. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 9527;

export function resolveHttpHost(override?: string): string {
  const envHost = process.env.CONFLUX_HOST?.trim();
  return envHost || override || DEFAULT_HTTP_HOST;
}

export function resolveHttpPort(override?: number): number {
  const envPort = process.env.CONFLUX_PORT?.trim();
  if (!envPort) return override ?? DEFAULT_HTTP_PORT;

  const port = Number(envPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid CONFLUX_PORT: ${envPort}`);
  }
  return port;
}
