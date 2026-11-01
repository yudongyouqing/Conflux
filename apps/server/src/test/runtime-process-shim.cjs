// Controllable stand-in for a managed CLI runtime process. The test copies
// this file to names like "claude" / "codex" so the production process
// inspector recognizes the command line, spawns it with node, and drives
// the real bind/stop/refresh paths against its OS pid.
//
// usage: node <path>/claude <mode> <reportFile>
//   stay          stay alive until terminated
//   delayed-exit  (POSIX) ignore the first SIGTERM, exit on the second —
//                 exercises the stop_requested_at path
//
// The report file records pid, CONFLUX_RUNTIME_INSTANCE_ID, CONFLUX_HOME
// and CONFLUX_RESUME_SESSION_ID as they arrived in the environment, which
// is what the real hook/MCP registration would observe.
const [, , mode = "stay", reportFile] = process.argv;

if (reportFile) {
  require("node:fs").writeFileSync(
    reportFile,
    JSON.stringify({
      pid: process.pid,
      instanceId: process.env.CONFLUX_RUNTIME_INSTANCE_ID ?? null,
      home: process.env.CONFLUX_HOME ?? null,
      resume: process.env.CONFLUX_RESUME_SESSION_ID ?? null,
      argv: process.argv.slice(2),
    }),
  );
}

if (mode === "delayed-exit" && process.platform !== "win32") {
  let signals = 0;
  process.on("SIGTERM", () => {
    if (++signals >= 2) process.exit(0);
  });
}

setInterval(() => {}, 60000);
