import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installSessionCommands } from "../cli/session-commands.js";

test("command installer supports both clients, custom homes, idempotence and conflict backups", (t) => {
  const home = mkdtempSync(join(tmpdir(), "conflux command home "));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = join(home, "custom codex");
  const claudeHome = join(home, "custom claude");
  const args = { client: "all" as const, home, codexHome, claudeHome };
  const installed = installSessionCommands(args);
  assert.equal(installed.length, 2);
  assert.ok(installed.every((item) => item.changed));
  for (const item of installed) {
    const text = readFileSync(item.path, "utf8");
    assert.match(text, /name: conflux/);
    assert.match(text, /list_session_directory/);
    assert.match(text, /does not authorize/);
  }
  assert.ok(installSessionCommands(args).every((item) => !item.changed));
  const target = join(codexHome, "skills", "conflux", "SKILL.md");
  writeFileSync(target, "my customized instructions");
  assert.throws(() => installSessionCommands(args), /--force/);
  assert.equal(readFileSync(target, "utf8"), "my customized instructions");
  const replaced = installSessionCommands({ ...args, force: true });
  const backup = replaced.find((item) => item.client === "codex")?.backup;
  assert.ok(backup);
  assert.equal(readFileSync(backup, "utf8"), "my customized instructions");
  assert.match(readFileSync(target, "utf8"), /name: conflux/);
});

test("installer checks every target before changing any client", (t) => {
  const home = mkdtempSync(join(tmpdir(), "conflux command conflict "));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, ".claude", "skills", "conflux", "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "unrelated skill");
  assert.throws(() => installSessionCommands({ client: "all", home }), /--force/);
  assert.throws(
    () => readFileSync(join(home, ".codex", "skills", "conflux", "SKILL.md")),
    /ENOENT/,
  );
  assert.equal(readFileSync(target, "utf8"), "unrelated skill");
});
