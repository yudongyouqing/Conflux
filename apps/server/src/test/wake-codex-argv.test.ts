import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexPinnedMcpArgs, codexPinnedMcpSuffix, wakeShell } from "../core/wake/launcher.js";
import { cmdQuote, posixQuote } from "../core/terminal.js";

// Codex overrides ride a SHELL command string. The raw tokens contain TOML
// literals with arbitrary paths (spaces, parens, ampersands...); joining
// them naively lets the shell split them into wrong argv. The suffix must
// quote each token so the real production shell delivers EXACTLY the raw
// tokens — verified here by an argv probe spawned the same way
// launchWakeRun spawns (wakeShell + windowsVerbatimArguments on win32).

function shellArgvRoundTrip(dataDir: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "cfx-argv-"));
  try {
    const probe = join(root, "argv-probe.cjs");
    writeFileSync(probe, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const onWindows = process.platform === "win32";
    // production invocation: env placeholders + delayed expansion on win32
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, CONFLUX_HOME: root };
    const shell = wakeShell(process.platform, { delayedExpansion: onWindows });
    const command = onWindows
      ? `${cmdQuote(process.execPath)} ${cmdQuote(probe)} ${codexPinnedMcpSuffix(dataDir, "win32", spawnEnv)}`
      : `${posixQuote(process.execPath)} ${posixQuote(probe)} ${codexPinnedMcpSuffix(dataDir, "linux")}`;
    const output = execFileSync(shell.command, [...shell.args, command], {
      cwd: root,
      env: spawnEnv,
      windowsHide: true,
      timeout: 10_000,
      encoding: "utf8",
      // execFileSync types lack this spawn option; production passes it to
      // spawn() and the probe needs identical cmd.exe argument semantics
      ...({ windowsVerbatimArguments: true } as object),
    });
    return JSON.parse(output) as string[];
  } finally {
    assert.equal(dirname(root), tmpdir(), "cleanup guard");
    rmSync(root, { recursive: true, force: true });
  }
}

test("codex override tokens survive the Windows shell as complete argv", () => {
  if (process.platform !== "win32") return;
  const dataDir = join("C:", "Project folder", "项目", "lib with spaces & (parens)");
  const overrides = codexPinnedMcpArgs(dataDir);
  const actual = shellArgvRoundTrip(dataDir);
  assert.deepEqual(
    actual,
    overrides,
    "the production join must deliver each override as ONE argv token",
  );
  // the pinned database is still readable inside the delivered args
  const dirIdx = actual[actual.findIndex((t) => t.startsWith("mcp_servers.conflux.args="))].indexOf("--data-dir");
  void dirIdx;
  assert.ok(
    actual.some((token) => token.includes(dataDir)),
    "the full data-dir path must arrive intact",
  );
});

test("codex override tokens survive the POSIX shell as complete argv", () => {
  if (process.platform === "win32") return;
  // single quotes force the TOML triple-literal AND exercise posix escaping
  const dataDir = "/tmp/lib with spaces & 'quotes'";
  const overrides = codexPinnedMcpArgs(dataDir);
  const actual = shellArgvRoundTrip(dataDir);
  assert.deepEqual(actual, overrides, "sh must deliver each override as ONE argv token");
});

test("the suffix never bare-joins: posix quotes, windows uses placeholders", () => {
  const dataDir = "/opt/some lib";
  const suffix = codexPinnedMcpSuffix(dataDir, "linux");
  assert.ok(suffix.includes("'"), "posix suffix must quote");
  // win32 without the spawn env is a programming error, not a silent fallback
  assert.throws(() => codexPinnedMcpSuffix(dataDir, "win32"), /requires the spawn env/);
  const env: NodeJS.ProcessEnv = {};
  const winSuffix = codexPinnedMcpSuffix(dataDir, "win32", env);
  assert.match(winSuffix, /!CONFLUX_WAKE_ARG_\d+!/, "windows suffix is placeholder-based");
  assert.ok(Object.keys(env).some((k) => k.startsWith("CONFLUX_WAKE_ARG_")), "tokens live in env");
  assert.notEqual(winSuffix, codexPinnedMcpArgs(dataDir).join(" "), "never a bare join");
});
