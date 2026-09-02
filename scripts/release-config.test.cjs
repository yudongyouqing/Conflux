const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("CI runs server tests, builds, desktop tests, and secret scan", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /npm test -w apps\/server/);
  assert.match(ci, /npm run build/);
  assert.match(ci, /test:desktop/);
  assert.match(ci, /check:secrets/);
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /macos-latest/);
});

test("release workflow builds Windows artifacts from a version tag", () => {
  const release = read(".github/workflows/release.yml");
  assert.match(release, /tags:\s*[\r\n]+\s+- ['"]?v\*/);
  assert.match(release, /windows-latest/);
  assert.match(release, /electron-builder/);
  assert.match(release, /upload-artifact/);
  assert.match(release, /--win nsis/);
  assert.match(release, /--win dir/);
});

test("root scripts expose reproducible CI and directory packaging commands", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["ci:test"], /npm test -w apps\/server/);
  assert.match(packageJson.scripts["ci:build"], /npm run build/);
  assert.match(packageJson.scripts["package:desktop:dir"], /--dir/);
});
