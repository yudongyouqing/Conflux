import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { wakeShell, wrapWakeCommandLine, ensureQuotedExecutable } from "../core/wake/launcher.js";
import { cmdQuote } from "../core/terminal.js";

// The whole-line placeholder protects EVERYTHING: enabling /v:on for only
// part of the line let !VAR! sequences in the CLI executable path expand
// and break the launch (exit 0 → 1). The regression runs a fake CLI from
// literal-marker directories through the exact production invocation.

function launchFakeCli(markerDir: string, root: string, env: NodeJS.ProcessEnv): number | null {
  mkdirSync(markerDir, { recursive: true });
  const exe = join(markerDir, "probe-cli.cmd");
  writeFileSync(exe, "@echo probe-cli-invoked\r\n");
  const literalLine = `${cmdQuote(exe)} exec -`;
  const shell = wakeShell("win32", { delayedExpansion: true });
  const result = spawnSync(shell.command, [...shell.args, wrapWakeCommandLine(ensureQuotedExecutable(literalLine), env)], {
    env,
    cwd: root,
    windowsVerbatimArguments: true,
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.match(result.stdout ?? "", /probe-cli-invoked/, "the fake CLI must actually run");
  return result.status;
}

function guarded(root: string, run: () => void) {
  try {
    run();
  } finally {
    assert.equal(dirname(root), tmpdir(), "cleanup guard");
    rmSync(root, { recursive: true, force: true });
  }
}

test("a literal !VAR! directory in the executable path survives /v:on", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "cfx-prefix-bang-"));
  guarded(root, () => {
    const env = { ...process.env, CFX_EXECUTABLE_MARKER: "MISSING_EXECUTABLE_DIR" };
    const status = launchFakeCli(join(root, "!CFX_EXECUTABLE_MARKER!"), root, env);
    assert.equal(status, 0, "delayed expansion rewrote the literal executable directory");
  });
});

test("a literal %VAR% directory in the executable path survives cmd", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "cfx-prefix-percent-"));
  guarded(root, () => {
    const env = { ...process.env, CFX_EXECUTABLE_MARKER: "MISSING_EXECUTABLE_DIR" };
    const status = launchFakeCli(join(root, "%CFX_EXECUTABLE_MARKER%"), root, env);
    assert.equal(status, 0, "percent expansion rewrote the literal executable directory");
  });
});
