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
  assert.match(ci, /desktop-tests:/);
  assert.match(ci, /node --test apps\/desktop\/test\//);
  assert.match(ci, /check:secrets/);
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /macos-latest/);
});

test("release workflow builds and publishes all desktop platforms from a version tag", () => {
  const release = read(".github/workflows/release.yml");
  assert.match(release, /tags:\s*[\r\n]+\s+- ['"]?v\*/);
  assert.match(release, /windows-latest/);
  assert.match(release, /macos-latest/);
  assert.match(release, /ubuntu-latest/);
  assert.match(release, /electron-builder/);
  assert.ok(
    release.indexOf("npm run build -w packages/shared") <
      release.indexOf("npm test -w apps/server"),
    "release workflow must build shared before server tests"
  );
  assert.match(release, /upload-artifact/);
  assert.match(release, /--\$\{\{ matrix\.flag \}\} \$\{\{ matrix\.target \}\}/);
  assert.match(release, /--publish never/);
  assert.match(release, /gh release create/);
  assert.match(release, /GH_TOKEN/);
  assert.match(release, /WINDOWS_CSC_LINK/);
  assert.match(release, /APPLE_ID/);
});

test("root scripts expose reproducible CI and directory packaging commands", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["ci:test"], /npm test -w apps\/server/);
  assert.match(packageJson.scripts["ci:build"], /npm run build/);
  assert.match(packageJson.scripts["package:desktop:dir"], /--dir/);
});
