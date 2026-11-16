import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  codexPinnedMcpArgs,
  codexPinnedMcpSuffix,
  wakeShell,
  wrapWakeCommandLine,
  ensureQuotedExecutable,
} from "../core/wake/launcher.js";
import { cmdQuote } from "../core/terminal.js";

// cmd expands %VAR% even inside double quotes: a pinned data dir containing
// literal percent-variable text would be rewritten before codex ever sees
// it. The suffix must use the managed-launch env-placeholder mechanism
// (leaf env content survives /v:on delayed expansion VERBATIM — verified
// empirically), and the round trip here proves it through the same shell
// invocation production uses.

function roundTrip(dataDir: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "cfx-percent-"));
  try {
    const probe = join(root, "argv-probe.cjs");
    writeFileSync(probe, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // hostile variables that MUST NOT leak into the delivered argv
      CFX_ARGV_REVIEW_MARKER: "WRONG_LIBRARY",
      CFX_ARGV_BANG: "WRONG_BANG",
    };
    // production form: the WHOLE line rides one env placeholder
    const literalLine = `${cmdQuote(process.execPath)} ${cmdQuote(probe)} ${codexPinnedMcpSuffix(dataDir, "win32")}`;
    const shell = wakeShell("win32", { delayedExpansion: true });
    const command = wrapWakeCommandLine(ensureQuotedExecutable(literalLine), env);
    const output = execFileSync(shell.command, [...shell.args, command], {
      cwd: root,
      env,
      windowsHide: true,
      timeout: 10_000,
      encoding: "utf8",
      ...({ windowsVerbatimArguments: true } as object),
    });
    return JSON.parse(output) as string[];
  } finally {
    assert.equal(dirname(root), tmpdir(), "cleanup guard");
    rmSync(root, { recursive: true, force: true });
  }
}

test("percent- and bang-variable literals in the data dir survive cmd", () => {
  if (process.platform !== "win32") return;
  const dataDir = join("C:", "library", "%CFX_ARGV_REVIEW_MARKER%", "!CFX_ARGV_BANG!", "with spaces");
  const expected = codexPinnedMcpArgs(dataDir);
  const actual = roundTrip(dataDir);
  assert.deepEqual(
    actual,
    expected,
    "cmd rewrote the literal library path despite quoting — percent/bang expansion",
  );
  // the delivered args still carry the FULL literal path
  assert.ok(
    actual.some((token) => token.includes("%CFX_ARGV_REVIEW_MARKER%")),
    "the percent literal must arrive intact",
  );
  assert.ok(
    actual.some((token) => token.includes("!CFX_ARGV_BANG!")),
    "the bang literal must arrive intact",
  );
});
