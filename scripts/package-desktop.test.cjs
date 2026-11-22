"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  hasPathSpaces,
  resolvePrebuiltBinary,
  resolveSpaceFreeBase,
  stageAndRebuildNativeModule,
} = require("./package-desktop.cjs");

test("hasPathSpaces detects whitespace in checkout paths", () => {
  assert.equal(hasPathSpaces("C:\\Project folder\\项目\\muiltchat"), true);
  assert.equal(hasPathSpaces("/Users/dev/my project/conflux"), true);
  assert.equal(hasPathSpaces("C:\\src\\conflux"), false);
});

test("resolvePrebuiltBinary locates non-empty N-API prebuilds and ignores missing or empty files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-prebuild-"));
  const prebuilds = path.join(root, "node_modules", "better-sqlite3", "prebuilds");
  fs.mkdirSync(prebuilds, { recursive: true });
  try {
    assert.equal(resolvePrebuiltBinary(root, "win32", "x64"), null);
    const bin = path.join(prebuilds, "win32-x64.node");
    fs.writeFileSync(bin, "");
    assert.equal(resolvePrebuiltBinary(root, "win32", "x64"), null, "empty prebuild rejected");
    fs.writeFileSync(bin, "napi-v10-binary");
    assert.equal(resolvePrebuiltBinary(root, "win32", "x64"), bin);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSpaceFreeBase selects the first writable space-free directory and rejects space-only lists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-base-"));
  const spaced = path.join(tmp, "with space");
  const clean = path.join(tmp, "clean");
  fs.mkdirSync(spaced, { recursive: true });
  fs.mkdirSync(clean, { recursive: true });
  try {
    assert.equal(resolveSpaceFreeBase([spaced, clean]), clean);
    assert.throws(() => resolveSpaceFreeBase([spaced]), /space-free temporary directory/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("stageAndRebuildNativeModule stages module in a space-free dir and rejects silent no-op rebuilds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-stage-test-"));
  const fakeRepo = path.join(root, "Project folder", "muiltchat");
  const fakeMod = path.join(fakeRepo, "node_modules", "better-sqlite3");
  const cleanBase = path.join(root, "tmpbase");
  fs.mkdirSync(path.join(fakeMod, "build", "Release"), { recursive: true });
  fs.mkdirSync(cleanBase, { recursive: true });
  fs.writeFileSync(
    path.join(fakeMod, "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }),
    "utf8",
  );
  // Seed a stale Node-ABI binary to prove staging strips pre-existing build output.
  fs.writeFileSync(path.join(fakeMod, "build", "Release", "better_sqlite3.node"), "stale-node-abi");

  try {
    // 1. Silent no-op rebuild (like subst "No native modules found") must fail loudly.
    await assert.rejects(
      () =>
        stageAndRebuildNativeModule({
          repoRoot: fakeRepo,
          electronVersion: "45.0.0",
          arch: "x64",
          stagingBase: cleanBase,
          rebuildFn: async () => {},
        }),
      /without producing/,
    );

    // 2. Real rebuild output succeeds in a space-free buildPath and exposes the fresh binary.
    let seenBuildPath = null;
    const result = await stageAndRebuildNativeModule({
      repoRoot: fakeRepo,
      electronVersion: "45.0.0",
      arch: "x64",
      stagingBase: cleanBase,
      rebuildFn: async ({ buildPath }) => {
        seenBuildPath = buildPath;
        const out = path.join(buildPath, "node_modules", "better-sqlite3", "build", "Release");
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, "better_sqlite3.node"), "fresh-electron-abi");
      },
    });
    assert.ok(seenBuildPath && !hasPathSpaces(seenBuildPath), "buildPath must be space-free");
    assert.equal(fs.readFileSync(result.builtBinary, "utf8"), "fresh-electron-abi");
    result.cleanup();
    assert.equal(fs.existsSync(result.stageDir), false, "cleanup removes staging dir");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
