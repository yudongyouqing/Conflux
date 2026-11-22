"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NATIVE_MODULE = "better-sqlite3";
const NATIVE_BINARY_REL = path.join("build", "Release", "better_sqlite3.node");

function hasPathSpaces(targetPath) {
  return /\s/.test(targetPath);
}

function isLinuxMusl() {
  if (process.platform !== "linux") return false;
  const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  return !report?.header?.glibcVersionRuntime;
}

function resolvePrebuiltBinary(repoRoot = ROOT, platform = process.platform, arch = process.arch) {
  const target = `${platform === "linux" && isLinuxMusl() ? "linuxmusl" : platform}-${arch}`;
  const candidate = path.join(repoRoot, "node_modules", NATIVE_MODULE, "prebuilds", `${target}.node`);
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
      return candidate;
    }
  } catch {
    // fall through
  }
  return null;
}

function resolveSpaceFreeBase(candidates) {
  const list =
    candidates ??
    [
      process.env.CONFLUX_REBUILD_TMP,
      os.tmpdir(),
      process.env.TEMP,
      process.env.TMP,
      process.platform === "win32" ? `${process.env.SystemDrive || "C:"}\\` : "/tmp",
    ].filter(Boolean);

  for (const raw of list) {
    const resolved = path.resolve(raw);
    if (hasPathSpaces(resolved)) continue;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        fs.accessSync(resolved, fs.constants.W_OK);
        return resolved;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    "No writable space-free temporary directory available for native Electron rebuild. " +
      "Set CONFLUX_REBUILD_TMP to a writable path without spaces.",
  );
}

function readInstalledVersion(repoRoot, pkgName) {
  const pkgPath = path.join(repoRoot, "node_modules", pkgName, "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
}

function copyDirSync(src, dest, skipTopLevel) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipTopLevel && skipTopLevel.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d, null);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

async function stageAndRebuildNativeModule({
  repoRoot = ROOT,
  moduleName = NATIVE_MODULE,
  binaryRel = NATIVE_BINARY_REL,
  electronVersion,
  arch = process.arch,
  stagingBase,
  rebuildFn,
}) {
  const base = resolveSpaceFreeBase(stagingBase ? [stagingBase] : undefined);
  const stageDir = fs.mkdtempSync(path.join(base, "conflux-rebuild-"));
  const moduleSrc = path.join(repoRoot, "node_modules", moduleName);
  if (!fs.existsSync(moduleSrc)) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw new Error(`Native module not found at ${moduleSrc}`);
  }

  const version = readInstalledVersion(repoRoot, moduleName);
  const stageModuleDir = path.join(stageDir, "node_modules", moduleName);
  fs.mkdirSync(path.dirname(stageModuleDir), { recursive: true });
  fs.writeFileSync(
    path.join(stageDir, "package.json"),
    JSON.stringify(
      {
        name: "conflux-native-rebuild-stage",
        private: true,
        dependencies: { [moduleName]: version },
      },
      null,
      2,
    ),
    "utf8",
  );
  // Drop pre-existing build output and prebuilds so a fallback source rebuild produces a fresh binary.
  copyDirSync(moduleSrc, stageModuleDir, new Set(["build", "prebuilds"]));

  const modPkg = JSON.parse(fs.readFileSync(path.join(moduleSrc, "package.json"), "utf8"));
  const directDeps = new Set([
    ...Object.keys(modPkg.dependencies || {}),
    ...Object.keys(modPkg.optionalDependencies || {}),
    "node-addon-api",
    "prebuild-install",
  ]);
  for (const dep of directDeps) {
    const depSrc = path.join(repoRoot, "node_modules", dep);
    const depDest = path.join(stageDir, "node_modules", dep);
    if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
      copyDirSync(depSrc, depDest, null);
    }
  }

  const runRebuild = rebuildFn ?? require("@electron/rebuild").rebuild;
  try {
    await runRebuild({
      buildPath: stageDir,
      electronVersion,
      arch,
      onlyModules: [moduleName],
      force: true,
      useCache: false,
    });

    const builtBinary = path.join(stageModuleDir, binaryRel);
    if (!fs.existsSync(builtBinary) || fs.statSync(builtBinary).size === 0) {
      throw new Error(
        `Electron native rebuild completed without producing ${binaryRel} for ${moduleName} ` +
          `(Electron ${electronVersion}, arch ${arch})`,
      );
    }

    return {
      stageDir,
      builtBinary,
      cleanup() {
        fs.rmSync(stageDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
}

function electronBuilderCli(repoRoot) {
  return path.join(repoRoot, "node_modules", "electron-builder", "cli.js");
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const builderArgs = ["--projectDir", "apps/desktop", "--config", "electron-builder.yml", ...extraArgs];
  const prebuilt = resolvePrebuiltBinary(ROOT);

  let backupBytes = null;
  let stage = null;
  const targetBinary = path.join(ROOT, "node_modules", NATIVE_MODULE, NATIVE_BINARY_REL);

  try {
    if (prebuilt) {
      // better-sqlite3 v13+ ships universal N-API v10 prebuilds compatible with Electron;
      // skipping electron-builder's npmRebuild avoids node-gyp space-path failures altogether.
      console.log(`[package-desktop] Using N-API prebuild: ${path.relative(ROOT, prebuilt)}`);
      builderArgs.push("--config.npmRebuild=false");
    } else if (hasPathSpaces(ROOT)) {
      const electronVersion = readInstalledVersion(ROOT, "electron");
      console.log(
        `[package-desktop] Checkout path contains spaces; rebuilding ${NATIVE_MODULE} ` +
          `for Electron ${electronVersion} (${process.arch}) in a space-free staging directory...`,
      );
      if (fs.existsSync(targetBinary)) {
        backupBytes = fs.readFileSync(targetBinary);
      }
      stage = await stageAndRebuildNativeModule({
        repoRoot: ROOT,
        electronVersion,
        arch: process.arch,
      });
      console.log(`[package-desktop] Rebuilt ${NATIVE_MODULE} -> ${stage.builtBinary}`);
      fs.mkdirSync(path.dirname(targetBinary), { recursive: true });
      fs.copyFileSync(stage.builtBinary, targetBinary);
      builderArgs.push("--config.npmRebuild=false");
    }

    const res = spawnSync(process.execPath, [electronBuilderCli(ROOT), ...builderArgs], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      process.exitCode = res.status ?? 1;
    }
  } finally {
    if (backupBytes !== null) {
      try {
        fs.writeFileSync(targetBinary, backupBytes);
      } catch (restoreErr) {
        console.warn(`[package-desktop] Failed to restore Node-ABI ${NATIVE_MODULE}:`, restoreErr.message);
      }
    }
    if (stage) {
      try {
        stage.cleanup();
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[package-desktop] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

module.exports = {
  hasPathSpaces,
  resolvePrebuiltBinary,
  resolveSpaceFreeBase,
  stageAndRebuildNativeModule,
};
