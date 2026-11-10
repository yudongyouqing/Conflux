import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanTerminalEnv, posixQuote } from "../terminal.js";
import { resolveConfig } from "../../config.js";
import { withMcpConfig } from "./commands.js";
import { setSetting } from "../app-settings.js";
import { psMatchClauses } from "../runtime-identity.js";
import { logger } from "../../log.js";
import { incrementWakeCount, decrementWakeCount } from "./counter.js";
import type { DB } from "../db.js";

/**
 * One wake run: spawn the command, deliver the prompt via stdin, optionally
 * pin codex identity, stamp the dedup key. All spawn mechanics live here —
 * the per-runtime modules only decide WHAT to run.
 */

export interface LaunchRequest {
  db: DB;
  sessionId: string;
  /** data dir for wake-log capture (#102 streaming) */
  dataDir?: string;
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
 * Environment for a spawned wake run. The woken executor's MCP/CLI must
 * land on the SAME database this server owns: without an explicit
 * CONFLUX_HOME a server started with a custom --data-dir or CONFLUX_HOME
 * would wake children that silently fall back to the default data
 * directory — the room-task executor in that situation cannot see its
 * task rows at all. Exported for the no-cross-database regression.
 */
export function wakeRunEnv(req: { dataDir?: string }, baseEnv: NodeJS.ProcessEnv = process.env) {
  const env = cleanTerminalEnv(baseEnv);
  if (req.dataDir) env.CONFLUX_HOME = req.dataDir;
  return env;
}

/**
 * Shell for headless wake launches. Windows runs the command string through
 * cmd.exe; everywhere else it must be /bin/sh — `process.env.comspec ??
 * "cmd.exe"` unconditionally spawns a nonexistent cmd.exe on macOS/Linux
 * and the wake silently never starts (#105).
 *
 * `delayedExpansion` adds /v:on for commands that reference env
 * placeholders (`!VAR!`): leaf env content survives delayed expansion
 * VERBATIM, including literal %VAR% and !VAR! text — the only cmd-safe
 * way to pass argv with arbitrary path characters.
 */
export function wakeShell(
  platform: NodeJS.Platform = process.platform,
  opts: { delayedExpansion?: boolean } = {},
): {
  command: string;
  args: string[];
} {
  if (platform === "win32") {
    return {
      command: process.env.comspec ?? "cmd.exe",
      args: opts.delayedExpansion ? ["/d", "/v:on", "/s", "/c"] : ["/d", "/s", "/c"],
    };
  }
  return { command: "/bin/sh", args: ["-c"] };
}

/**
 * Write (idempotently) a minimal MCP mount config pointing at THIS server
 * install, so a woken claude always has check_inbox/reply_ask even when the
 * target project never mounted Conflux in its own .mcp.json (#105).
 */
export function ensureWakeMcpConfig(
  dataDir?: string,
  serverEntry?: string,
  launch?: { command: string; args: string[]; env?: Record<string, string> },
): string {
  const dir = dataDir ?? resolveConfig("global").dataDir;
  const entry = serverEntry ?? defaultServerEntry();
  const path = join(dir, "wake-mcp.json");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: { conflux: launch ?? { command: "npx", args: ["tsx", entry, "mcp"] } },
    }),
    "utf8",
  );
  return path;
}

/**
 * MCP mount launch pinned to one data dir via --data-dir: the mounted
 * conflux server resolves THAT database no matter what environment the
 * host CLI passes (or scrubs) — the executor lands on the orchestrator's
 * library even when a resumed session carries user-level MCP config.
 * Single source of truth; runtime-agents' managed mounts delegate here.
 */
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

/**
 * Codex config overrides pinning the mounted conflux server to one data
 * dir. Codex scrubs MCP child environments, so env pinning cannot work
 * there — codex wakes must carry the library in their -c config
 * overrides or the executor lands on whatever database the host config
 * happens to name.
 */
export function codexPinnedMcpArgs(dataDir: string): string[] {
  const literal = (value: string) => (value.includes("'") ? `'''${value}'''` : `'${value}'`);
  const launch = pinnedMcpLaunch(dataDir);
  return [
    "-c",
    `mcp_servers.conflux.command=${literal(launch.command)}`,
    "-c",
    `mcp_servers.conflux.args=[${launch.args.map(literal).join(",")}]`,
    ...(process.versions.electron
      ? ["-c", "mcp_servers.conflux.env.ELECTRON_RUN_AS_NODE='1'"]
      : []),
  ];
}

/** cmd-safe double-quoting per the managed-launch rules: inner quotes
 *  escaped, trailing backslashes doubled. */
export function winArgQuote(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

/**
 * The codex overrides as a literal command segment: every token quoted
 * for the target shell (winArgQuote on cmd, posixQuote for sh). On
 * Windows this string rides inside the whole-line env placeholder (see
 * wrapWakeCommandLine) — cmd expands %VAR% even inside double quotes, so
 * quoting alone is never the delivery mechanism there.
 */
export function codexPinnedMcpSuffix(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const tokens = codexPinnedMcpArgs(dataDir);
  return platform === "win32"
    ? tokens.map(winArgQuote).join(" ")
    : tokens.map(posixQuote).join(" ");
}

/**
 * The executable MUST be a quoted first token under /v:on: a bare command
 * word followed by quoted args containing special characters makes cmd
 * fail with "filename syntax incorrect" (bisected empirically). Planners
 * already cmdQuote the exe, but cmdQuote skips quoting when the path has
 * no spaces/bangs — this guarantees the first token is quoted regardless.
 * A space-containing path that reached here unquoted was already broken
 * before delayed expansion; we do not guess token boundaries for it.
 */
export function ensureQuotedExecutable(line: string): string {
  if (line.startsWith('"')) return line;
  const firstSpace = line.indexOf(" ");
  if (firstSpace === -1) return `"${line}"`;
  return `"${line.slice(0, firstSpace)}" ${line.slice(firstSpace + 1)}`;
}

/**
 * Deliver an ENTIRE wake command line through one env placeholder:
 * env gets the literal line, cmd runs `!CONFLUX_WAKE_LINE!` with /v:on.
 * Delayed expansion inserts the content verbatim — %VAR% and !VAR!
 * literals anywhere in the line (executable path, args, pinned mounts)
 * survive, because the only thing cmd expands is the placeholder itself.
 * Verified empirically; this is the managed-launch mechanism applied to
 * the whole line instead of only the MCP suffix.
 */
export function wrapWakeCommandLine(line: string, env: NodeJS.ProcessEnv): string {
  env.CONFLUX_WAKE_LINE = line;
  return "!CONFLUX_WAKE_LINE!";
}

/**
 * The server entry that can host the MCP server: resolved from THIS module's
 * location (src via tsx → index.ts, compiled dist → index.js). Never from
 * process.argv — that breaks whenever the wake is launched from a script
 * whose argv[1] is not the server entry (observed: empty entry in the
 * generated config, headless run started with a dead MCP mount).
 */
export function defaultServerEntry(): string {
  // __filename is available in both compiled CJS and under tsx (shimmed);
  // tsconfig targets CommonJS so import.meta is off the table here.
  const here = __filename;
  return join(dirname(here), "..", "..", here.endsWith(".ts") ? "index.ts" : "index.js");
}

export function launchWakeRun(req: LaunchRequest): LaunchResult {
  // A wake aimed at a deleted/unmounted project directory must be a
  // RECORDED refusal, never a spawn: node reports a bad spawn cwd as an
  // async ENOENT on the shell itself (cmd.exe / sh), which no caller can
  // map back to this wake. No fallback cwd either — quietly waking in
  // another directory would read the wrong files and MCP mounts.
  if (req.projectDir && !existsSync(req.projectDir)) {
    const error = `project dir missing: ${req.projectDir}`;
    logger.warn(
      { sessionId: req.sessionId, projectDir: req.projectDir },
      "wake refused: project dir missing",
    );
    return { ok: false, error };
  }
  // The data dir ALWAYS comes from the caller's db handle unless explicitly
  // overridden: a server on a custom home wakes executors onto THAT home —
  // deriving from config again here is exactly how the split-database
  // regressions happened (room tasks invisible to their own executors).
  const dataDir = req.dataDir ?? dirname(req.db.name);
  // env first: the codex suffix writes its placeholder variables here
  // (leaf content survives cmd delayed expansion verbatim — the only
  // %-expansion-proof way to pass argv on Windows)
  const env = wakeRunEnv({ ...req, dataDir });
  env.CONFLUX_ASSUME_SESSION = req.sessionId;
  // Pin policy: EVERY launch this server controls carries an explicit
  // same-database mount. A project .mcp.json that names conflux proves
  // nothing about WHICH database it targets — presence alone must never
  // bypass pinning (a same-named CLI mount overrides it without changing
  // the tools array shape, so the cached-prefix cost stays bounded).
  const literalLine = req.pinCodex
    ? `${req.command} ${codexPinnedMcpSuffix(dataDir, process.platform)}`
    : withMcpConfig(req.command, ensureWakeMcpConfig(dataDir, undefined, pinnedMcpLaunch(dataDir)));
  // On Windows the WHOLE line — executable path, original args and mounts —
  // rides one env placeholder under /v:on: cmd's %VAR% expansion would
  // otherwise rewrite literal paths, and enabling /v:on for only part of
  // the line would let !VAR! sequences in the executable path expand.
  const command =
    process.platform === "win32"
      ? wrapWakeCommandLine(ensureQuotedExecutable(literalLine), env)
      : literalLine;
  // dry-run previews the literal line; it writes the idempotent
  // wake-mcp.json but spawns nothing
  if (req.dryRun) return { ok: true, command: literalLine };

  const shell = wakeShell(process.platform, {
    delayedExpansion: process.platform === "win32",
  });
  // stdout piped for wake-log capture (#102 streaming); falls back to
  // "ignore" when the data dir is unknown (shouldn't happen — resolveConfig
  // is always available)
  const captureStdout = !!req.dataDir;
  const child = spawn(shell.command, [...shell.args, command], {
    detached: process.platform !== "win32",
    stdio: ["pipe", captureStdout ? "pipe" : "ignore", "ignore"],
    env,
    cwd: req.projectDir ?? undefined,
    windowsVerbatimArguments: process.platform === "win32",
    windowsHide: true,
  });

  // Concurrency accounting for the wake limit. A spawn that FAILS after
  // this point never fires "exit", so both paths release the slot exactly
  // once; an async spawn failure is contained here — the wake dies, the
  // daemon must not.
  incrementWakeCount();
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    decrementWakeCount();
  };
  child.on("exit", releaseSlot);
  child.on("error", (err) => {
    logger.error(
      { sessionId: req.sessionId, err: err instanceof Error ? err.message : String(err) },
      "wake spawn failed — run aborted, daemon continues",
    );
    releaseSlot();
  });

  if (captureStdout && req.dataDir) {
    pipeWakeLog(child, req.dataDir, req.sessionId);
  }
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

/** Append the spawned child's stdout to <dataDir>/wake-logs/<sessionId>.log */
function pipeWakeLog(child: ReturnType<typeof spawn>, dataDir: string, sessionId: string): void {
  try {
    const dir = join(dataDir, "wake-logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fd = openSync(join(dir, `${sessionId}.log`), "a");
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        writeSync(fd, chunk);
      } catch {
        // disk full — the wake already succeeded
      }
    });
    child.stdout?.on("end", () => {
      try {
        writeSync(fd, `\n[wake ended ${new Date().toISOString()}]\n`);
        closeSync(fd);
      } catch {
        // already closed
      }
    });
    child.on("error", () => {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "wake log open failed");
  }
}
