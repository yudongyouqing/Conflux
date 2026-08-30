const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveRuntimePaths } = require("../src/runtime-paths.cjs");

test("resolves packaged resources without using process.cwd", () => {
  const originalCwd = process.cwd;
  process.cwd = () => {
    throw new Error("packaged path resolution must not read process.cwd");
  };

  try {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      resourcesPath: "C:\\Program Files\\Conflux\\resources",
      appPath: "C:\\Program Files\\Conflux\\resources\\app.asar",
    });

    assert.equal(
      paths.serverEntry,
      "C:\\Program Files\\Conflux\\resources\\app.asar\\apps\\server\\dist\\index.js"
    );
    assert.equal(
      paths.webDist,
      "C:\\Program Files\\Conflux\\resources\\app.asar\\apps\\web\\dist"
    );
  } finally {
    process.cwd = originalCwd;
  }
});

test("resolves development resources from the desktop app path", () => {
  const paths = resolveRuntimePaths({
    isPackaged: false,
    resourcesPath: "C:\\repo\\node_modules\\electron\\dist\\resources",
    appPath: "C:\\repo\\apps\\desktop",
  });

  assert.equal(paths.repoRoot, "C:\\repo");
  assert.equal(paths.serverEntry, "C:\\repo\\apps\\server\\dist\\index.js");
  assert.equal(paths.webDist, "C:\\repo\\apps\\web\\dist");
});
