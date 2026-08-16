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
    terminal: "wt",
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

  // empty string resets to default; unknown choice rejected
  assert.equal(saveTerminalSettings(db, { claude_path: "  " }).claude_path, "claude");
  assert.throws(() => saveTerminalSettings(db, { terminal: "iterm" as never }));
});

test("buildLaunchPlan: wt first with fallback, cmd-only for cmd choice", () => {
  const base = { command: '"claude" --resume abc', cwd: "C:/work/dir", title: "muiltchat · x" };
  const wt = buildLaunchPlan({ terminal: "wt" }, base);
  assert.equal(wt[0].file, "wt.exe");
  assert.deepEqual(wt[0].args.slice(0, 2), ["-d", "C:/work/dir"]);
  assert.ok(wt[0].args.includes("cmd.exe"));
  assert.ok(wt.some((s) => s.file.endsWith("cmd.exe") && s.verbatim), "cmd start fallback present");

  const wez = buildLaunchPlan({ terminal: "wezterm" }, base);
  assert.equal(wez[0].file, "wezterm.exe");
  assert.deepEqual(wez[0].args.slice(0, 3), ["start", "--cwd", "C:/work/dir"]);

  const cmd = buildLaunchPlan({ terminal: "cmd" }, base);
  assert.equal(cmd.length, 1);
  assert.equal(cmd[0].verbatim, true);
  assert.ok(cmd[0].args.join(" ").includes("start"));
});

test("buildLaunchPlan: powershell runs the command directly with pwsh fallback chain", () => {
  const plan = buildLaunchPlan(
    { terminal: "powershell" },
    { command: "claude --resume abc", cwd: "C:/work/dir", title: "t" }
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
