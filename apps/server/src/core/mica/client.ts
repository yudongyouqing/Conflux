import { execFile, spawn } from "node:child_process";
import type { MicaBadgeState, MicaPaneInfo, MicaReadResult } from "@conflux/shared";

/**
 * Thin typed wrapper around the Mica CLI control channel.
 *
 * All invocations go through execFile/spawn with shell:false so user-supplied
 * paths, commands, and terminal text can never be re-interpreted by a shell.
 */

export type MicaErrorCode =
  | "spawn_failed"
  | "not_running"
  | "bad_target"
  | "cli_error"
  | "timeout"
  | "invalid_output";

export class MicaCliError extends Error {
  readonly code: MicaErrorCode;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(code: MicaErrorCode, message: string, stderr = "", exitCode: number | null = null) {
    super(message);
    this.name = "MicaCliError";
    this.code = code;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface MicaRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface MicaExecOptions {
  timeoutMs?: number;
}

export interface MicaProcessHandle {
  kill(): void;
  exited: Promise<void>;
}

export interface MicaRunner {
  exec(args: string[], opts?: MicaExecOptions): Promise<MicaRunResult>;
  spawn(
    args: string[],
    listeners: { onStdoutLine: (line: string) => void; onSpawnError: (err: Error) => void },
  ): MicaProcessHandle;
}

export const MICA_TIMEOUTS = {
  list: 5_000,
  focus: 5_000,
  badge: 5_000,
  send: 5_000,
  read: 8_000,
  spawnPane: 15_000,
} as const;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof (err as NodeJS.ErrnoException)?.code === "string";
}

/** Default runner: direct execFile/spawn against the resolved Mica executable. */
export function createDefaultMicaRunner(executable: string): MicaRunner {
  const runExecFile = (
    args: string[],
    timeoutMs: number,
  ): Promise<{ err: Error | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        executable,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          shell: false,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => resolve({ err: err ?? null, stdout: stdout ?? "", stderr: stderr ?? "" }),
      );
    });

  return {
    async exec(args, opts = {}) {
      const { err, stdout, stderr } = await runExecFile(args, opts.timeoutMs ?? 10_000);
      if (!err) return { stdout, stderr, code: 0 };
      // execFile timeouts report killed+SIGTERM with a NULL code — check that
      // FIRST, otherwise a wedged CLI masquerades as "not running" (list) or
      // an anonymous exit-null failure.
      if ((err as { killed?: boolean }).killed) {
        throw new MicaCliError("timeout", `mica ${args[0]} 超时`, stderr);
      }
      if (isErrnoException(err)) {
        // String `code` means the failure happened at spawn level, not a plain
        // non-zero exit: ENOENT -> missing binary.
        throw new MicaCliError("spawn_failed", `无法启动 Mica CLI（${err.message}）`, stderr);
      }
      // Non-zero exit: output may still be meaningful, surface it to the caller.
      const exitCode = (err as { code?: unknown }).code;
      return { stdout, stderr, code: typeof exitCode === "number" ? exitCode : null };
    },
    spawn(args, listeners) {
      const child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line.trim()) listeners.onStdoutLine(line);
          idx = buffer.indexOf("\n");
        }
      });
      child.on("error", (err) => listeners.onSpawnError(err));
      return {
        kill: () => {
          try {
            child.kill();
          } catch {
            // already gone
          }
        },
        exited: new Promise<void>((resolve) => {
          child.on("close", () => resolve());
          child.on("error", () => resolve());
        }),
      };
    },
  };
}

export interface MicaListResult {
  running: boolean;
  panes: MicaPaneInfo[];
}

export interface MicaOpenPaneOptions {
  mode: "tab" | "window";
  cwd: string;
  command?: string;
  env?: Record<string, string>;
}

export interface MicaBadgeOptions {
  state: MicaBadgeState;
  text?: string | null;
  sticky?: boolean;
}

function parseJsonOutput<T>(label: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new MicaCliError("invalid_output", `mica ${label} 返回了无法解析的输出`, stdout);
  }
}

function throwForExit(label: string, res: MicaRunResult): void {
  if (res.code === 0) return;
  if (res.stderr.includes("bad_target")) {
    throw new MicaCliError(
      "bad_target",
      `目标 Mica pane 已关闭或不存在（mica ${label}）`,
      res.stderr,
      res.code,
    );
  }
  throw new MicaCliError(
    "cli_error",
    `mica ${label} 执行失败（exit ${res.code}）${res.stderr.trim() ? `：${res.stderr.trim().slice(0, 200)}` : ""}`,
    res.stderr,
    res.code,
  );
}

export interface MicaClient {
  list(): Promise<MicaListResult>;
  openPane(opts: MicaOpenPaneOptions): Promise<MicaPaneInfo>;
  focus(paneId: number): Promise<void>;
  send(paneId: number, text: string, opts?: { literal?: boolean }): Promise<void>;
  read(paneId: number, opts?: { scrollback?: boolean; lines?: number }): Promise<MicaReadResult>;
  setBadge(paneId: number, badge: MicaBadgeOptions): Promise<void>;
}

export function createMicaClient(runner: MicaRunner): MicaClient {
  return {
    async list() {
      const res = await runner.exec(["list", "--json"], { timeoutMs: MICA_TIMEOUTS.list });
      if (res.code !== 0) {
        // No running Mica instance: `mica list` exits 1 without spawning the GUI.
        return { running: false, panes: [] };
      }
      const panes = parseJsonOutput<MicaPaneInfo[]>("list", res.stdout);
      if (!Array.isArray(panes)) {
        throw new MicaCliError("invalid_output", "mica list 返回了非数组输出", res.stdout);
      }
      return { running: true, panes };
    },

    async openPane(opts) {
      const args = [opts.mode === "window" ? "new-window" : "new-tab", "--cwd", opts.cwd];
      if (opts.command) args.push("--command", opts.command);
      for (const [key, value] of Object.entries(opts.env ?? {})) {
        // Mica injects MICA_PANE_ID itself and rejects external overrides;
        // Windows env vars are case-insensitive, so match either casing.
        if (key.toUpperCase() === "MICA_PANE_ID") continue;
        args.push("--env", `${key}=${value}`);
      }
      args.push("--json");
      const res = await runner.exec(args, { timeoutMs: MICA_TIMEOUTS.spawnPane });
      throwForExit(args[0], res);
      const pane = parseJsonOutput<MicaPaneInfo>(args[0], res.stdout);
      if (typeof pane?.pane_id !== "number") {
        throw new MicaCliError("invalid_output", `mica ${args[0]} 返回的 pane 信息不完整`, res.stdout);
      }
      return pane;
    },

    async focus(paneId) {
      const res = await runner.exec(["focus", `--pane=${paneId}`], { timeoutMs: MICA_TIMEOUTS.focus });
      throwForExit("focus", res);
    },

    async send(paneId, text, sendOpts = {}) {
      const args = ["send", `--pane=${paneId}`];
      if (sendOpts.literal) args.push("--literal");
      args.push("--", text);
      const res = await runner.exec(args, { timeoutMs: MICA_TIMEOUTS.send });
      throwForExit("send", res);
    },

    async read(paneId, readOpts = {}) {
      const args = ["read", `--pane=${paneId}`, "--json"];
      if (readOpts.scrollback) args.push("--scrollback");
      if (typeof readOpts.lines === "number" && Number.isFinite(readOpts.lines)) {
        args.push("--lines", String(Math.max(1, Math.floor(readOpts.lines))));
      }
      const res = await runner.exec(args, { timeoutMs: MICA_TIMEOUTS.read });
      throwForExit("read", res);
      const out = parseJsonOutput<MicaReadResult>("read", res.stdout);
      if (typeof out?.text !== "string") {
        throw new MicaCliError("invalid_output", "mica read 返回的快照不完整", res.stdout);
      }
      return out;
    },

    async setBadge(paneId, badge) {
      const args = ["badge", `--pane=${paneId}`, "--state", badge.state];
      if (badge.text != null && badge.text !== "") args.push("--text", badge.text);
      if (badge.sticky) args.push("--sticky");
      const res = await runner.exec(args, { timeoutMs: MICA_TIMEOUTS.badge });
      throwForExit("badge", res);
    },
  };
}
