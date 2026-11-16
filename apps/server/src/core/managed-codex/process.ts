import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { logger } from "../../log.js";
import { ManagedRpcConnection, type RpcHandlers } from "./rpc.js";

/**
 * Process adapter for the managed Codex executor: turn a configured
 * executable (real exe, node script, or npm cmd shim) into a spawnable
 * command, run the app-server with stdio pipes, and wire its stdout into a
 * ManagedRpcConnection. Nothing here knows about threads/turns — lifecycle
 * and protocol only.
 */

export interface LaunchPlan {
  command: string;
  args: string[];
}

/**
 * Resolve how to spawn the configured executable.
 *
 * Windows npm installs expose CLIs as `foo.cmd` shims that only work through
 * cmd.exe. With shell:false (required: the prompt must never touch a shell
 * command line) a cmd shim cannot be spawned directly, so it is parsed back
 * into `node <script.js>`; .js entries get node; real executables (and
 * anything already runnable, e.g. an absolute .exe or a POSIX binary) pass
 * through untouched.
 */
export function resolveLaunchPlan(
  executable: string,
  args: string[] = [],
  platform: NodeJS.Platform = process.platform,
): LaunchPlan {
  const trimmed = executable.trim();
  if (!trimmed) throw new Error("executable is empty");
  const lower = trimmed.toLowerCase();

  if (platform === "win32") {
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return cmdShimPlan(trimmed, args);
    }
    if (lower.endsWith(".js") || lower.endsWith(".cjs") || lower.endsWith(".mjs")) {
      return { command: process.execPath, args: [trimmed, ...args] };
    }
    if (lower.endsWith(".exe")) {
      return { command: trimmed, args };
    }
    // Bare command: Node's spawn does NOT search PATHEXT, so a bare "codex"
    // would try to execute a nonexistent extensionless file. Resolve it the
    // way cmd would, then classify the hit (cmd shim vs real exe).
    const resolved = resolveOnPathWindows(trimmed);
    if (!resolved) {
      throw new Error(`executable not found on PATH: ${trimmed} — set the codex path in settings`);
    }
    if (resolved.toLowerCase().endsWith(".cmd") || resolved.toLowerCase().endsWith(".bat")) {
      return cmdShimPlan(resolved, args);
    }
    return { command: resolved, args };
  }

  // POSIX: JS entries go through node too — checked-out files carry no
  // execute bit (CI's EACCES), and a shebang would still race umasks.
  if (lower.endsWith(".js") || lower.endsWith(".cjs") || lower.endsWith(".mjs")) {
    return { command: process.execPath, args: [trimmed, ...args] };
  }
  return { command: trimmed, args };
}

function cmdShimPlan(shimPath: string, args: string[]): LaunchPlan {
  const script = scriptBehindCmdShim(shimPath);
  if (script) return { command: process.execPath, args: [script, ...args] };
  throw new Error(
    `cannot resolve npm cmd shim to a node script: ${shimPath} — configure the codex executable directly`,
  );
}

/** PATHEXT-aware PATH lookup for a bare command name on Windows. cmd.exe
 *  never executes extensionless files (an adjacent sh script with the same
 *  name is for Git Bash, not for us), so only PATHEXT extensions count. */
function resolveOnPathWindows(command: string): string | null {
  const pathDirs = (process.env.PATH ?? "").split(";");
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = exts.map((ext) => `${command}${ext}`);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = resolve(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Extract the node script an npm cmd shim forwards to. Shims reference the
 * package script as `%~dp0\...\foo.js` (relative to the shim directory) or
 * via quoted absolute paths; the first existing script file wins.
 */
function scriptBehindCmdShim(shimPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shimPath);
  // Shims reference the script either via %~dp0\... (direct expansion) or
  // SET dp0 + %dp0%\... (npm's variable form) — both resolve relative to
  // the shim's own directory. The captured tail uses Windows separators;
  // normalize them so the lookup also works when CONFLUX runs on POSIX
  // (resolving a .cmd shim a Windows install left behind, and the tests).
  for (const match of content.matchAll(/(?:%~dp0|%dp0%)\\([^"'\r\n]+?\.(?:js|mjs|cjs))/g)) {
    const candidate = resolve(dir, match[1].replace(/\\/g, "/"));
    if (existsSync(candidate)) return candidate;
  }
  for (const match of content.matchAll(/"([A-Za-z]:[^"'\r\n]+?\.(?:js|mjs|cjs))"/g)) {
    if (existsSync(match[1])) return resolve(match[1]);
  }
  return null;
}

export interface SpawnAppServerOptions {
  executable: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  handlers?: RpcHandlers;
  rpcOptions?: ConstructorParameters<typeof ManagedRpcConnection>[2];
}

export interface AppServerProcess {
  child: ChildProcess;
  conn: ManagedRpcConnection;
  /** Resolves when the child exits; rejects nothing — check code/signal. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Stderr tail (bounded) for diagnostics. */
  stderrTail: () => string;
  /** Terminate the child and fail all pending RPC. */
  kill: () => void;
}

/**
 * Spawn the app-server and connect its stdio to a fresh RPC connection.
 * Environment and cwd are inherited EXPLICITLY (no implicit process.env
 * spread here) — callers pass a built env so CONFLUX_HOME and credentials
 * never leak in by accident.
 */
export function spawnAppServer(opts: SpawnAppServerOptions): AppServerProcess {
  const plan = resolveLaunchPlan(opts.executable, opts.args ?? []);
  const child = spawn(plan.command, plan.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
  });

  const stderrChunks: string[] = [];
  const STDERR_CAP = 16 * 1024;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    // Keep the newest bytes within the cap; diagnostics only, never logged
    // verbatim (app-server stderr may contain environment details).
    stderrChunks.push(chunk);
    const overflow = stderrChunks.join("").length - STDERR_CAP;
    if (overflow > 0) {
      let dropped = 0;
      while (dropped < overflow && stderrChunks.length > 1) dropped += stderrChunks.shift()!.length;
    }
  });

  let exitedResolve: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    exitedResolve = res;
  });

  const conn = new ManagedRpcConnection(
    {
      write: (frame) => {
        if (!child.stdin?.writable) return;
        child.stdin.write(frame);
      },
      close: () => {
        // Fail-safe teardown of the pipes; the child gets a chance to exit
        // on its own, then the exit handler finalizes.
        try {
          child.stdin?.end();
        } catch {
          // already gone
        }
      },
    },
    opts.handlers,
    opts.rpcOptions,
  );

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => conn.handleChunk(chunk));
  child.stdout?.on("end", () => conn.handleEnd());
  child.stdout?.on("error", () => conn.handleEnd());
  child.stdin?.on("error", () => {
    /* EPIPE when the child died first — exit/close handlers take over */
  });

  const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
    conn.close(
      Object.assign(new Error(`app-server exited (code ${code ?? "null"}, signal ${signal ?? "null"})`), {
        name: "RpcClosedError",
      }),
    );
    exitedResolve!({ code, signal });
    logger.info(
      { pid: child.pid, code, signal },
      "managed codex app-server process exited",
    );
  };
  child.once("exit", finalize);
  child.once("error", (err) => {
    logger.warn({ err: err.message }, "managed codex app-server spawn error");
    finalize(null, null);
  });

  return {
    child,
    conn,
    exited,
    stderrTail: () => stderrChunks.join(""),
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      conn.close(Object.assign(new Error("killed by manager"), { name: "RpcClosedError" }));
      if (process.platform === "win32") {
        child.once("error", () => {});
        child.kill();
      } else {
        child.kill("SIGTERM");
      }
    },
  };
}

/** Convenience for tests/tools: the argv for an app-server subprocess. */
export function appServerArgv(extra: string[] = []): string[] {
  return ["app-server", ...extra];
}

/** Join with the shim log directory convention (exposed for tests). */
export function shimLogPath(dir: string): string {
  return join(dir, "shim-rpc.log");
}
