import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { TerminalChoice, TerminalOption, TerminalSettings } from "@muiltchat/shared";
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
    "SHELL",
    "USER",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
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

/** POSIX sh single-quoting: everything unlisted stays literal inside '...'. */
export function posixQuote(s: string): string {
  return /^[-A-Za-z0-9_@%+=:,./]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ordered candidate list for one opener choice (macOS). Env cannot ride
 * along with the osascript/tmux spawn (Terminal.app and the tmux server run
 * in their own environments), so vars are inlined into the command string.
 * Pure — unit-testable without spawning anything.
 */
function macLaunchPlan(
  settings: Pick<TerminalSettings, "terminal">,
  opts: { command: string; cwd?: string; title: string; env?: NodeJS.ProcessEnv }
): LaunchSpec[] {
  const envPrefix = opts.env
    ? Object.entries(opts.env)
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `${k}=${posixQuote(String(v))}`)
        .join(" ")
    : "";
  const inner =
    (opts.cwd ? `cd ${posixQuote(opts.cwd)} && ` : "") +
    (envPrefix ? `env ${envPrefix} ` : "") +
    opts.command;
  // AppleScript string literal: escape backslashes and double quotes.
  const apple = `"${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  const terminalApp = (): LaunchSpec => ({
    file: "/usr/bin/osascript",
    args: [
      "-e",
      'tell application "Terminal"',
      "-e",
      "activate",
      "-e",
      `do script ${apple}`,
      "-e",
      "end tell",
    ],
  });
  const iterm = (): LaunchSpec => ({
    file: "/usr/bin/osascript",
    args: [
      "-e",
      'tell application "iTerm2"',
      "-e",
      "activate",
      "-e",
      "set w to create window with default profile",
      "-e",
      `tell current session of w to write text ${apple}`,
      "-e",
      "end tell",
    ],
  });
  const tmux = (): LaunchSpec => ({
    // The window lives in the tmux server (auto-started if none); attach
    // from any terminal to see it. Env is inlined for the same reason as
    // above — new windows inherit the SERVER's environment, not ours.
    file: "tmux",
    args: [
      "new-window",
      "-n",
      opts.title,
      ...(opts.cwd ? ["-c", opts.cwd] : []),
      "sh",
      "-c",
      inner,
    ],
  });

  if (settings.terminal === "iterm") return [iterm(), terminalApp()];
  if (settings.terminal === "tmux") return [tmux(), terminalApp()];
  // "terminal" default — and any windows-flavoured choice that leaked into
  // the same DB via a synced home dir — lands on Terminal.app, which every
  // Mac has.
  return [terminalApp()];
}

/**
 * The ordered candidate list for one opener choice. The inner command runs
 * under `cmd.exe /d /k` so the window stays open after the CLI exits.
 * Pure — unit-testable without spawning anything.
 */
export function buildLaunchPlan(
  settings: Pick<TerminalSettings, "terminal">,
  opts: { command: string; cwd?: string; title: string; env?: NodeJS.ProcessEnv },
  io: { platform?: NodeJS.Platform } = {}
): LaunchSpec[] {
  const platform = io.platform ?? process.platform;
  if (platform === "darwin") return macLaunchPlan(settings, opts);
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
  // pwsh runs the command directly (-NoExit keeps the window open); the
  // cmd-syntax `title &&` prefix would not parse there.
  const pwshSpec = (file: string): LaunchSpec => ({
    file,
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", command],
    cwd,
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
  if (settings.terminal === "powershell") return [pwshSpec("pwsh.exe"), pwshSpec("powershell.exe"), cmdStart()];
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

// ---- which terminals does this machine actually have? -----------------------

const TERMINAL_FILES: Record<TerminalChoice, string[]> = {
  wt: ["wt.exe"],
  powershell: ["pwsh.exe", "powershell.exe"],
  cmd: ["cmd.exe"],
  wezterm: ["wezterm.exe"],
  terminal: ["/usr/bin/osascript"],
  iterm: ["/Applications/iTerm.app", "iterm2"],
  tmux: ["tmux"],
};

const TERMINAL_LABELS: Record<TerminalChoice, { label: string; hint: string }> = {
  wt: { label: "Windows Terminal", hint: "wt.exe · 未安装时自动回退" },
  powershell: { label: "PowerShell", hint: "pwsh / powershell · 未安装时回退 cmd" },
  cmd: { label: "系统默认", hint: "cmd start 新窗口 · 兼容性最好" },
  wezterm: { label: "WezTerm", hint: "wezterm.exe · 缺失时回退 wt → cmd" },
  terminal: { label: "Terminal.app", hint: "macOS 自带 · 经 osascript 打开" },
  iterm: { label: "iTerm2", hint: "缺 iTerm2 时回退 Terminal.app" },
  tmux: { label: "tmux", hint: "窗口在 tmux 服务端 · attach 查看;缺失回退 Terminal.app" },
};

/**
 * Resolve an executable via the OS (`where.exe`). existsSync-walking PATH is
 * NOT reliable here: serve often runs under git-bash whose PATH is a hybrid
 * MSYS/Windows string, and Store-app aliases like wt.exe are reparse points
 * that statSync fails on with EACCES. `where` handles both correctly.
 */
export function resolveOnPath(
  exe: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (/[\\/]/.test(exe)) return existsSync(exe) ? exe : null;
  // macOS has no where.exe; /usr/bin/which covers it (no Store-alias quirks).
  const resolver = platform === "darwin" ? "/usr/bin/which" : "where.exe";
  try {
    const r = spawnSync(resolver, [exe], {
      encoding: "utf8",
      timeout: 5000,
      env: baseEnv,
      windowsHide: true,
    });
    if (r.status === 0) {
      const first = (r.stdout || "").trim().split(/\r?\n/)[0];
      return first || null;
    }
  } catch {
    // resolver unavailable — treat as unresolved
  }
  return null;
}

/**
 * Dropdown entries for the settings UI with live PATH availability —
 * we never assume which terminals the user has (AgentRecall exposes the
 * same select-style list; the launch plan still falls back if one is
 * chosen but missing).
 */
export function terminalOptions(
  baseEnv: NodeJS.ProcessEnv = process.env,
  io: { platform?: NodeJS.Platform } = {}
): TerminalOption[] {
  const platform = io.platform ?? process.platform;
  const order: TerminalChoice[] =
    platform === "darwin"
      ? ["terminal", "iterm", "tmux"]
      : ["wt", "powershell", "cmd", "wezterm"];
  return order.map((value) => ({
    value,
    ...TERMINAL_LABELS[value],
    available: TERMINAL_FILES[value].some((f) => resolveOnPath(f, baseEnv, platform) !== null),
  }));
}

/**
 * Wake-up prompt for auto-answer. Fixed framing: another session asked you
 * something — read the mail, answer FROM your real conversation context
 * (the wake resumes this very conversation), send it back via reply_ask.
 */
export const AUTO_WAKE_PROMPT =
  "你收到一条来自其他会话的消息:请立即调用 muiltchat 的 check_inbox 查看收件箱,结合本会话已有的工作上下文,用 reply_ask 把回复发给提问方,然后结束本轮,不要做其他事。";

/** Pre-authorized tools for headless runs (-p cannot show permission prompts). */
export const HEADLESS_ALLOWED_TOOLS = "mcp__muiltchat__*";

/**
 * codex exec defaults to approval policy "never", under which MCP tool
 * calls are REJECTED headlessly ("MCP tool call requires approval") — the
 * wake could never reach check_inbox. The bypass flag is the only way to
 * let a headless run use MCP tools; the wake prompt is our own trusted
 * text, and the run's cwd is the session's project dir.
 */
const CODEX_WAKE_FLAGS = "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check";

/** Full headless wake command: resume the conversation and drive the reply. */
export function wakeCommand(
  runtime: "claude" | "codex",
  sessionId: string,
  executable: string
): string {
  if (runtime === "codex") {
    return `${cmdQuote(executable)} exec resume ${sessionId} ${CODEX_WAKE_FLAGS} ${cmdQuote(AUTO_WAKE_PROMPT)}`;
  }
  return `${resumeCommand("claude", sessionId, executable)} --allowedTools ${cmdQuote(
    HEADLESS_ALLOWED_TOOLS
  )} -p ${cmdQuote(AUTO_WAKE_PROMPT)}`;
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
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error("opening a terminal is supported on Windows and macOS only");
  }
  const env = opts.env ?? cleanTerminalEnv();
  const plan = buildLaunchPlan(settings, { ...opts, env }, { platform });

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
  throw new Error(
    platform === "darwin"
      ? `no terminal available (${lastError}) — macOS 自带 Terminal.app,理论上不应发生`
      : `no terminal available (${lastError}) — install Windows Terminal or set 终端打开方式 为 "系统默认"`
  );
}
