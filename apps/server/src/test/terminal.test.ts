import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  buildLaunchPlan,
  resumeCommand,
  cleanTerminalEnv,
  resolveOnPath,
  terminalOptions,
} from "../core/terminal.js";
import {
  getTerminalSettings,
  saveTerminalSettings,
} from "../core/app-settings.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("getTerminalSettings returns defaults on a fresh db", () => {
  assert.deepEqual(getTerminalSettings(db), {
    terminal: process.platform === "darwin" ? "terminal" : "wt",
    claude_path: "claude",
    codex_path: "codex",
  });
});

test("saveTerminalSettings merges partials and validates the choice", () => {
  const saved = saveTerminalSettings(db, { terminal: "wezterm", claude_path: "C:/tools/claude.exe" });
  assert.equal(saved.terminal, "wezterm");
  assert.equal(saved.claude_path, "C:/tools/claude.exe");
  assert.equal(saved.codex_path, "codex", "untouched field keeps its default");

  const reread = getTerminalSettings(db);
  assert.equal(reread.terminal, "wezterm");
  assert.equal(reread.claude_path, "C:/tools/claude.exe");

  // empty string resets to default; unknown choice rejected (iterm is a
  // LEGAL macOS choice now — use a genuinely bogus value)
  assert.equal(saveTerminalSettings(db, { claude_path: "  " }).claude_path, "claude");
  assert.throws(() => saveTerminalSettings(db, { terminal: "ghost-term" as never }));
});

test("buildLaunchPlan: wt first with fallback, cmd-only for cmd choice", () => {
  const base = { command: '"claude" --resume abc', cwd: "C:/work/dir", title: "muiltchat · x" };
  const win32 = { platform: "win32" as NodeJS.Platform };
  const wt = buildLaunchPlan({ terminal: "wt" }, base, win32);
  assert.equal(wt[0].file, "wt.exe");
  assert.deepEqual(wt[0].args.slice(0, 2), ["-d", "C:/work/dir"]);
  assert.ok(wt[0].args.includes("cmd.exe"));
  assert.ok(wt.some((s) => s.file.endsWith("cmd.exe") && s.verbatim), "cmd start fallback present");

  const wez = buildLaunchPlan({ terminal: "wezterm" }, base, win32);
  assert.equal(wez[0].file, "wezterm.exe");
  assert.deepEqual(wez[0].args.slice(0, 3), ["start", "--cwd", "C:/work/dir"]);

  const cmd = buildLaunchPlan({ terminal: "cmd" }, base, win32);
  assert.equal(cmd.length, 1);
  assert.equal(cmd[0].verbatim, true);
  assert.ok(cmd[0].args.join(" ").includes("start"));
});

test("buildLaunchPlan: powershell runs the command directly with pwsh fallback chain", () => {
  const win32 = { platform: "win32" as NodeJS.Platform };
  const plan = buildLaunchPlan(
    { terminal: "powershell" },
    { command: "claude --resume abc", cwd: "C:/work/dir", title: "t" },
    win32
  );
  assert.equal(plan[0].file, "pwsh.exe");
  assert.deepEqual(plan[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NoExit", "-Command"]);
  assert.equal(plan[0].args[4], "claude --resume abc", "raw command, no cmd-syntax title prefix");
  assert.equal(plan[0].cwd, "C:/work/dir");
  assert.equal(plan[1].file, "powershell.exe");
  assert.equal(plan[2].verbatim, true, "cmd start is the last fallback");
});

test("resolveOnPath resolves via where.exe (handles Store aliases); terminalOptions reports availability", () => {
  if (process.platform !== "win32") return; // where.exe is Windows-only
  assert.ok(resolveOnPath("cmd.exe"), "cmd.exe resolvable on any Windows box");
  assert.equal(resolveOnPath("definitely-missing-exe-xyz"), null);

  const opts = terminalOptions();
  assert.deepEqual(
    opts.map((o) => o.value),
    ["wt", "powershell", "cmd", "wezterm"]
  );
  const cmdOpt = opts.find((o) => o.value === "cmd")!;
  assert.equal(cmdOpt.available, true);
  assert.ok(opts.every((o) => typeof o.label === "string" && o.label.length > 0));
});

test("resumeCommand builds runtime-correct commands with quoted paths", () => {
  assert.equal(resumeCommand("claude", "abc-123", "claude"), "claude --resume abc-123");
  assert.equal(
    resumeCommand("codex", "abc-123", "C:/Program Files/codex.exe"),
    '"C:/Program Files/codex.exe" resume abc-123'
  );
});

test("cleanTerminalEnv drops session-scoped Claude vars", () => {
  const env = cleanTerminalEnv({
    PATH: "C:\\bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ANTHROPIC_AUTH_TOKEN: "secret",
    ANTHROPIC_MODEL: "glm",
  } as NodeJS.ProcessEnv);
  assert.equal(env.PATH, "C:\\bin");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_MODEL, undefined);
});

// ---- macOS launch plans -------------------------------------------------------

const darwin = { platform: "darwin" as NodeJS.Platform };
const macBase = {
  command: '"claude" --resume abc',
  cwd: "/Users/x/my proj",
  title: "muiltchat · x",
  env: { PATH: "/usr/local/bin:/usr/bin", ANTHROPIC_AUTH_TOKEN: "sk test" } as NodeJS.ProcessEnv,
};

test("darwin plan: Terminal.app osascript with inlined cd+env, posix-quoted", () => {
  const plan = buildLaunchPlan({ terminal: "terminal" }, macBase, darwin);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].file, "/usr/bin/osascript");
  const script = plan[0].args.join("\n");
  assert.ok(script.includes('tell application "Terminal"'));
  assert.ok(script.includes('do script "'));
  assert.ok(script.includes("cd '/Users/x/my proj'"), "space-containing cwd single-quoted");
  assert.ok(script.includes("ANTHROPIC_AUTH_TOKEN='sk test'"), "env inlined with quoting");
  assert.ok(script.includes('\\"claude\\" --resume abc'), "command quotes escaped for AppleScript");
});

test("darwin plan: iterm first with Terminal.app fallback; tmux new-window carries inline env", () => {
  const it = buildLaunchPlan({ terminal: "iterm" }, macBase, darwin);
  assert.ok(it[0].args.join(" ").includes("iTerm2"));
  assert.ok(it[0].args.join(" ").includes("write text"));
  assert.equal(it[1].file, "/usr/bin/osascript", "Terminal.app fallback");
  assert.ok(it[1].args.join(" ").includes('tell application "Terminal"'));

  const tm = buildLaunchPlan({ terminal: "tmux" }, { ...macBase, cwd: undefined }, darwin);
  assert.equal(tm[0].file, "tmux");
  assert.deepEqual(tm[0].args.slice(0, 3), ["new-window", "-n", "muiltchat · x"]);
  const shIdx = tm[0].args.indexOf("-c");
  assert.ok(tm[0].args[shIdx + 1].startsWith("env "), "env inlined into sh -c payload");
  assert.ok(tm[0].args[shIdx + 1].endsWith('"claude" --resume abc'), "no AppleScript escaping on the tmux path");
});

test("darwin plan: windows-flavoured choice falls back to Terminal.app", () => {
  const plan = buildLaunchPlan({ terminal: "wt" }, macBase, darwin);
  assert.equal(plan[0].file, "/usr/bin/osascript");
  assert.ok(plan[0].args.join(" ").includes('tell application "Terminal"'));
});

test("terminalOptions on darwin lists mac openers only", () => {
  const opts = terminalOptions(process.env, darwin);
  assert.deepEqual(
    opts.map((o) => o.value),
    ["terminal", "iterm", "tmux"]
  );
  assert.ok(opts.every((o) => typeof o.label === "string" && o.label.length > 0));
});

test("cleanTerminalEnv keeps POSIX essentials", () => {
  const env = cleanTerminalEnv({
    PATH: "/usr/local/bin",
    SHELL: "/bin/zsh",
    USER: "dev",
    TMPDIR: "/var/folders/xx",
    CLAUDECODE: "1",
  } as NodeJS.ProcessEnv);
  assert.equal(env.SHELL, "/bin/zsh");
  assert.equal(env.USER, "dev");
  assert.equal(env.TMPDIR, "/var/folders/xx");
  assert.equal(env.CLAUDECODE, undefined);
});
