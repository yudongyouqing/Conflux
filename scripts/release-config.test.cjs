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
  assert.match(ci, /npm run test:desktop/);
  assert.match(ci, /npm run lint/);
  assert.match(ci, /node --test scripts\/release-config\.test\.cjs/);
  assert.match(ci, /npm run check:tokens/);
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
  assert.doesNotMatch(
    release,
    /path:\s*\|\s*release\/\*\s*(?:\r?\n|$)/,
    "release artifacts must exclude unpacked directories"
  );
  assert.match(release, /--\$\{\{ matrix\.flag \}\} \$\{\{ matrix\.target \}\}/);
  assert.match(release, /--publish never/);
  assert.match(release, /gh release create/);
  assert.match(
    release,
    /publish:[\s\S]*?uses: actions\/checkout@v\d+[\s\S]*?gh release create/,
    "publish job must provide repository context for gh"
  );
  assert.match(release, /GH_TOKEN/);
  assert.match(release, /WINDOWS_CSC_LINK/);
  assert.match(release, /APPLE_ID/);
  assert.match(release, /name: Build Windows release[\s\S]*?CSC_LINK:/);
  assert.match(release, /name: Build macOS release[\s\S]*?APPLE_ID:/);
  assert.match(release, /name: Build Linux release[\s\S]*?electron-builder/);
  const macStep = release.split("- name: Build macOS release")[1].split("- name: Build Linux release")[0];
  assert.match(macStep, /secrets\.MAC_CSC_LINK/);
  assert.match(macStep, /secrets\.MAC_CSC_KEY_PASSWORD/);
  assert.match(macStep, /if \[\[ -n "\$MAC_SIGN_CERT" \]\]/);
  assert.match(macStep, /--mac dmg zip/);
  assert.match(release, /release\/\*\.zip/);
});

test("root scripts expose reproducible CI and directory packaging commands", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["ci:test"], /npm test -w apps\/server/);
  assert.match(packageJson.scripts["ci:build"], /npm run build/);
  assert.match(packageJson.scripts["package:desktop:dir"], /--dir/);
});
