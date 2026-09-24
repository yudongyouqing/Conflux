import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanTerminalEnv } from "../terminal.js";
import { resolveConfig } from "../../config.js";
import { withMcpConfig } from "./commands.js";
import { setSetting } from "../app-settings.js";
import { psMatchClauses } from "../runtime-identity.js";
import { logger } from "../../log.js";
import type { DB } from "../db.js";

/**
 * One wake run: spawn the command, deliver the prompt via stdin, optionally
 * pin codex identity, stamp the dedup key. All spawn mechanics live here —
 * the per-runtime modules only decide WHAT to run.
 */

export interface LaunchRequest {
  db: DB;
  sessionId: string;
  projectDir: string | null;
  command: string;
  prompt: string;
  /** pin all codex-shaped descendants of the launcher to this session */
  pinCodex: boolean;
  dryRun?: boolean;
  /** test seam: receives the spawned launcher pid */
  onSpawned?: (pid: number | undefined) => void;
}

export type LaunchResult = { ok: true; command: string } | { ok: false; error: string };

/**
 * Shell for headless wake launches. Windows runs the command string through
 * cmd.exe; everywhere else it must be /bin/sh — `process.env.comspec ??
 * "cmd.exe"` unconditionally spawns a nonexistent cmd.exe on macOS/Linux
 * and the wake silently never starts (#105).
 */
export function wakeShell(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  if (platform === "win32") {
    return { command: process.env.comspec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  return { command: "/bin/sh", args: ["-c"] };
}

/**
 * Write (idempotently) a minimal MCP mount config pointing at THIS server
 * install, so a woken claude always has check_inbox/reply_ask even when the
 * target project never mounted Conflux in its own .mcp.json (#105).
 */
export function ensureWakeMcpConfig(dataDir?: string, serverEntry?: string): string {
  const dir = dataDir ?? resolveConfig("global").dataDir;
  const entry = serverEntry ?? defaultServerEntry();
  const path = join(dir, "wake-mcp.json");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { conflux: { command: "npx", args: ["tsx", entry, "mcp"] } } }),
    "utf8",
  );
  return path;
}

/**
 * The server entry that can host the MCP server: resolved from THIS module's
 * location (src via tsx → index.ts, compiled dist → index.js). Never from
 * process.argv — that breaks whenever the wake is launched from a script
 * whose argv[1] is not the server entry (observed: empty entry in the
 * generated config, headless run started with a dead MCP mount).
 */
function defaultServerEntry(): string {
  // __filename is available in both compiled CJS and under tsx (shimmed);
  // tsconfig targets CommonJS so import.meta is off the table here.
  const here = __filename;
  return join(dirname(here), "..", "..", here.endsWith(".ts") ? "index.ts" : "index.js");
}

export function launchWakeRun(req: LaunchRequest): LaunchResult {
  if (req.dryRun) return { ok: true, command: req.command };

  // Identity, two channels (either suffices):
  //  1. env MUILTCHAT_ASSUME_SESSION — claude passes a full env to MCP
  //     children; codex SCRUBS it (verified empirically), so for codex:
  //  2. pid pin — the codex-spawned MCP adopts via its ancestor codex pid
  //     looking up `codex-current:<pid>`. Spawn first, pin immediately
  //     (the npm/tsx MCP chain takes seconds to boot — the pin always lands
  //     before the first tryAdopt), and the wake run acts as the target.
  const env = cleanTerminalEnv();
  env.MUILTCHAT_ASSUME_SESSION = req.sessionId;
  // claude wakes (pinCodex === false) get an explicit MCP mount so the
  // headless run can always reach check_inbox/reply_ask (#105)
  const command =
    req.pinCodex ? req.command : withMcpConfig(req.command, ensureWakeMcpConfig());
  const shell = wakeShell();
  const child = spawn(shell.command, [...shell.args, command], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "ignore", "ignore"],
    env,
    cwd: req.projectDir ?? undefined,
    windowsVerbatimArguments: process.platform === "win32",
    windowsHide: true,
  });
  // deliver the wake prompt via stdin — see commands.ts docblock
  child.stdin?.on("error", () => {});
  child.stdin?.end(req.prompt);
  child.unref();
  req.onSpawned?.(child.pid);
  if (req.pinCodex && typeof child.pid === "number") {
    pinCodexDescendants(req.db, child.pid, req.sessionId);
  }
  logger.info({ sessionId: req.sessionId, wakePid: child.pid }, "auto-wake launched");
  return { ok: true, command: req.command };
}

/**
 * The wake spawns via cmd.exe and `codex` resolves through npm shims, so
 * every codex-shaped process in the subtree (codex.exe, the codex.cmd shim,
 * @openai/codex node wrappers) may be the one the MCP ancestor walk matches
 * first. BFS the launcher's descendants, collect ALL matches at every depth
 * (never stop at the first level), and pin each to the target session.
 * Fire-and-forget: tryAdopt re-runs on every MCP beat, so a late pin still
 * converges.
 */
export function pinCodexDescendants(db: DB, launcherPid: number, sessionId: string): void {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$deadline=(Get-Date).AddSeconds(12)",
    "$all=@()",
    "while((Get-Date) -lt $deadline -and $all.Count -eq 0){",
    "  $frontier=@(LAUNCHER_PID)",
    "  foreach($i in 1..6){",
    '    $kids=@($frontier | ForEach-Object { Get-CimInstance Win32_Process -Filter "ParentProcessId=$_" })',
    "    if($kids.Count -eq 0){ break }",
    "$all+=@($kids | Where-Object { __RUNTIME_MATCH__ })",
    "    $frontier=@($kids.ProcessId)",
    "  }",
    "  if($all.Count -eq 0){ Start-Sleep -Milliseconds 300 }",
    "}",
    "if($all.Count -gt 0){ $all.ProcessId }",
  ]
    .join("\n")
    .replace("__RUNTIME_MATCH__", psMatchClauses("codex"))
    .replace("LAUNCHER_PID", String(launcherPid));
  execFile(
    "powershell.exe",
    ["-NoProfile", "-Command", ps],
    { timeout: 16_000, windowsHide: true },
    (err, stdout) => {
      const pids = String(stdout)
        .split(/[^0-9]+/)
        .filter((x) => x.length > 0)
        .map(Number);
      if (!err && pids.length > 0) {
        for (const pid of pids) setSetting(db, `codex-current:${pid}`, sessionId);
        logger.info({ sessionId, pids }, "codex wake pid(s) pinned");
      }
    },
  );
}
