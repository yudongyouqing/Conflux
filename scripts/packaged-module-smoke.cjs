const path = require("node:path");

const REQUIRED_MODULES = ["electron-updater", "better-sqlite3"];

async function verifyPackagedModules(asarPath, { loadModule = (p) => require(p) } = {}) {
  if (!asarPath || !path.isAbsolute(asarPath)) throw new Error("Expected absolute app.asar path");
  const failures = [];
  const modules = {};
  for (const name of REQUIRED_MODULES) {
    try {
      modules[name] = loadModule(path.join(asarPath, "node_modules", name));
      console.log(`ok packaged ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  if (modules["better-sqlite3"]) {
    let db;
    try {
      db = new modules["better-sqlite3"](":memory:");
      if (db.prepare("SELECT 1 AS one").get().one !== 1) throw new Error("SELECT 1 failed");
      console.log("ok packaged SQLite native binding (memory only)");
    } catch (error) {
      failures.push(`SQLite binding: ${error.message}`);
    } finally {
      db?.close();
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("packaged-module-smoke: all checks passed");
}

if (require.main === module) {
  verifyPackagedModules(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { REQUIRED_MODULES, verifyPackagedModules };
