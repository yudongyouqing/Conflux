import { spawnSync } from "node:child_process";
import type { TerminalSettings } from "@muiltchat/shared";
import { logger } from "../log.js";

/**
 * Terminal launching, AgentRecall-style: build an ORDERED list of candidate
 * launches and try each until one spawns (ENOENT → next). wt is the default
 * opener and falls back through cmd when wt.exe is not installed.
 */

/**
 * Minimal clean environment for a spawned agent terminal. The serve process
 * may carry session-scoped vars of the Claude Code session that started it
 * (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, its auth token and model overrides) —
 * leaking those into a fresh agent both breaks it and confuses identities.
 * So we whitelist the OS/user essentials instead of inheriting.
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

/** One candidate launch. verbatim = cmd.exe quirk mode (manual quoting). */
export interface LaunchSpec {
  file: string;
  args: string[];
  cwd?: string;
  /** cmd.exe needs windowsVerbatimArguments + hand-rolled quoting. */
  verbatim?: boolean;
}

/**
 * Quote a token for a cmd.exe command string (`start` chain). cmd cannot
 * embed quotes, so strip them instead of escaping.
 */
export function cmdQuote(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s;
}

/**
 * The ordered candidate list for one opener choice. The inner command runs
 * under `cmd.exe /d /k` so the window stays open after the CLI exits.
 * Pure — unit-testable without spawning anything.
 */
export function buildLaunchPlan(
  settings: Pick<TerminalSettings, "terminal">,
  opts: { command: string; cwd?: string; title: string }
): LaunchSpec[] {
  const { command, cwd, title } = opts;
  const titled = `title ${cmdQuote(title)} && ${command}`;

  const wt = (): LaunchSpec => ({
    file: "wt.exe",
    args: [
      ...(cwd ? ["-d", cwd] : []),
      "--title",
      title,
      "cmd.exe",
      "/d",
      "/k",
      titled,
    ],
  });
  const wezterm = (): LaunchSpec => ({
    file: "wezterm.exe",
    args: ["start", ...(cwd ? ["--cwd", cwd] : []), "--", "cmd.exe", "/d", "/k", titled],
  });
  // Plain new console window: the proven `cmd /c start` chain (a windowless
  // serve process cannot hand a console to a plain `cmd /k` child reliably).
  const cmdStart = (): LaunchSpec => ({
    file: process.env.comspec ?? "cmd.exe",
    args: ["/d", "/s", "/c", ["start", cmdQuote(title), ...(cwd ? ["/D", cmdQuote(cwd)] : []), "cmd.exe", "/d", "/k", command].join(" ")],
    cwd,
    verbatim: true,
  });

  if (settings.terminal === "cmd") return [cmdStart()];
  if (settings.terminal === "wezterm") return [wezterm(), wt(), cmdStart()];
  // wt (default): wt first, fall back through cmd when wt.exe is missing.
  return [wt(), cmdStart()];
}

/**
 * Build the resume command for a session (cmd-syntax string).
 * Pure — unit-testable.
 */
export function resumeCommand(
  runtime: "claude" | "codex",
  sessionId: string,
  executable: string
): string {
  const exe = cmdQuote(executable);
  return runtime === "codex" ? `${exe} resume ${sessionId}` : `${exe} --resume ${sessionId}`;
}

/**
 * Try each candidate in order; ENOENT (terminal not installed) moves to the
 * next, anything else (success or real failure) stops. NOT detached — a
 * DETACHED_PROCESS cmd has no console and `start` fails silently in it.
 * stdio must be ignored or the started child inherits the pipes and blocks.
 */
export function openInTerminal(
  settings: Pick<TerminalSettings, "terminal">,
  opts: { command: string; cwd?: string; title: string; env?: NodeJS.ProcessEnv },
  io: { platform?: NodeJS.Platform; comspec?: string } = {}
): { opener: string } {
  const platform = io.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("opening a terminal is Windows-only for now");
  }
  const plan = buildLaunchPlan(settings, opts);
  const env = opts.env ?? cleanTerminalEnv();

  let lastError = "no terminal launched";
  for (const spec of plan) {
    const res = spawnSync(spec.file, spec.args, {
      stdio: "ignore",
      timeout: 15_000,
      env,
      cwd: spec.cwd,
      windowsVerbatimArguments: spec.verbatim === true,
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        lastError = `${spec.file} not found`;
        continue; // try the next candidate terminal
      }
      throw new Error(`failed to launch ${spec.file}: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`failed to launch ${spec.file}: exit ${res.status}`);
    }
    logger.info({ opener: spec.file, title: opts.title }, "terminal opened");
    return { opener: spec.file };
  }
  throw new Error(`no terminal available (${lastError}) — install Windows Terminal or set 终端打开方式 为 "系统默认"`);
}
