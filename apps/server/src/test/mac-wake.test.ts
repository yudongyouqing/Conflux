import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeCommand } from "../core/wake/commands.js";
import { wakeShell } from "../core/wake/launcher.js";

test("claude wake command carries --mcp-config when a config path is given", () => {
  const withMcp = wakeCommand("claude", "sess-1", "claude", "/tmp/wake-mcp.json");
  assert.ok(withMcp.includes("--mcp-config"), "flag present");
  assert.ok(withMcp.includes("/tmp/wake-mcp.json"), "path present");
  const withoutMcp = wakeCommand("claude", "sess-1", "claude");
  assert.ok(!withoutMcp.includes("--mcp-config"), "optional: omitted without path");
  // codex wake must not get claude's flag
  const codex = wakeCommand("codex", "sess-1", "codex", "/tmp/wake-mcp.json");
  assert.ok(!codex.includes("--mcp-config"), "codex untouched");
});

test("wake shell is platform-appropriate — never cmd.exe on POSIX", () => {
  assert.deepEqual(wakeShell("win32"), {
    command: process.env.comspec ?? "cmd.exe",
    args: ["/d", "/s", "/c"],
  });
  for (const p of ["darwin", "linux"] as const) {
    const sh = wakeShell(p);
    assert.equal(sh.command, "/bin/sh");
    assert.deepEqual(sh.args, ["-c"]);
    assert.notEqual(sh.command, "cmd.exe");
  }
});

test("ensureWakeMcpConfig writes a conflux mount pointing at the given entry", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureWakeMcpConfig } = await import("../core/wake/launcher.js");
  const dir = mkdtempSync(join(tmpdir(), "wake-mcp-"));
  const path = ensureWakeMcpConfig(dir, "/repo/apps/server/src/index.ts");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(cfg.mcpServers.conflux.args, ["tsx", "/repo/apps/server/src/index.ts", "mcp"]);
  rmSync(dir, { recursive: true, force: true });
});
