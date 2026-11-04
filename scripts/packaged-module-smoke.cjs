const path = require("node:path");

/** Wait for natural exit as well as output, so a passing probe leaves no child. */
function waitForPtyEcho(child, { timeoutMs = 10000, exitGraceMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let output = "";
    let killTimer;
    let timedOut = false;
    let settled = false;
    const subscriptions = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      for (const subscription of subscriptions) subscription?.dispose();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTimer = setTimeout(() => finish(new Error("PTY did not exit after termination")), exitGraceMs);
      try { child.kill(); } catch (error) { finish(error); }
    }, timeoutMs);
    subscriptions.push(child.onData((chunk) => { output = (output + chunk).slice(-4096); }));
    subscriptions.push(child.onExit(({ exitCode }) => {
      if (timedOut) finish(new Error("PTY echo timed out"));
      else if (exitCode !== 0 || !output.includes("conflux-pty-smoke")) {
        finish(new Error(`PTY exited ${exitCode} without successful echo`));
      } else finish();
    }));
  });
}

async function main(asarPath) {
  if (!asarPath || !path.isAbsolute(asarPath)) throw new Error("Expected absolute app.asar path");
  const failures = [];
  const modules = {};
  for (const name of ["node-pty", "electron-updater", "better-sqlite3"]) {
    try {
      modules[name] = require(path.join(asarPath, "node_modules", name));
      console.log(`ok packaged ${name}`);
    } catch (error) { failures.push(`${name}: ${error.message}`); }
  }
  if (modules["better-sqlite3"]) {
    let db;
    try {
      db = new modules["better-sqlite3"](":memory:");
      if (db.prepare("SELECT 1 AS one").get().one !== 1) throw new Error("SELECT 1 failed");
      console.log("ok packaged SQLite native binding (memory only)");
    } catch (error) { failures.push(`SQLite binding: ${error.message}`); }
    finally { db?.close(); }
  }
  if (modules["node-pty"]) {
    try {
      const child = modules["node-pty"].spawn(
        process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        process.platform === "win32" ? ["/d", "/c", "echo conflux-pty-smoke"] : ["-c", "echo conflux-pty-smoke"],
        { cols: 40, rows: 5, cwd: process.cwd(), env: { ...process.env } },
      );
      await waitForPtyEcho(child);
      console.log("ok packaged PTY native binding and child exit");
    } catch (error) { failures.push(`PTY binding: ${error.message}`); }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("packaged-module-smoke: all checks passed");
}

if (require.main === module) main(process.argv[2]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { waitForPtyEcho };
