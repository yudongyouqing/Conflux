const net = require("node:net");
const { execFile } = require("node:child_process");

function parseNetstatOwner(output, host, port) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP") continue;
    if (fields[3].toUpperCase() !== "LISTENING") continue;
    if (!matchesEndpoint(fields[1], host, port)) continue;

    const pid = Number(fields[fields.length - 1]);
    if (Number.isSafeInteger(pid) && pid > 0) return { pid };
  }
  return null;
}

function parseTasklistCommand(output, pid) {
  const expectedPid = String(pid);
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*"([^"]*)","([0-9]+)"/);
    if (match && match[2] === expectedPid) return { command: match[1] };
  }
  return null;
}

async function findWindowsPortOwner(port, host = "127.0.0.1", { execFileFn = execFile } = {}) {
  if (process.platform !== "win32") return null;

  let netstat;
  try {
    netstat = await runExecFile(execFileFn, "netstat", ["-ano", "-p", "tcp"]);
  } catch {
    return null;
  }

  const owner = parseNetstatOwner(netstat.stdout, host, port);
  if (!owner) return null;

  try {
    const tasklist = await runExecFile(execFileFn, "tasklist", [
      "/FI",
      `PID eq ${owner.pid}`,
      "/FO",
      "CSV",
    ]);
    return { ...owner, ...(parseTasklistCommand(tasklist.stdout, owner.pid) ?? {}) };
  } catch {
    return owner;
  }
}

const findPortOwner = findWindowsPortOwner;

function assertPortAvailable(port, host = "127.0.0.1", { findOwner = findPortOwner } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new TypeError(`invalid port: ${port}`));
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    server.once("error", async (error) => {
      if (error.code !== "EADDRINUSE") {
        finish(reject, error);
        return;
      }

      let owner = null;
      try {
        owner = await findOwner(port, host);
      } catch {
        // The conflict is still actionable even when process lookup fails.
      }

      const ownerText = owner?.pid
        ? ` (PID ${owner.pid}${owner.command ? `; command ${owner.command}` : ""})`
        : " (unable to resolve owning process)";
      finish(
        reject,
        new Error(`Port ${host}:${port} is already in use${ownerText}`)
      );
    });

    server.once("listening", () => {
      server.close((error) => {
        if (error) finish(reject, error);
        else finish(resolve);
      });
    });

    server.listen({ host, port });
  });
}

function matchesEndpoint(endpoint, host, port) {
  const value = String(endpoint ?? "");
  const separator = value.lastIndexOf(":");
  if (separator < 0 || Number(value.slice(separator + 1)) !== port) return false;

  const endpointHost = value.slice(0, separator).replace(/^\[|\]$/g, "");
  return (
    endpointHost === host ||
    (host === "127.0.0.1" && endpointHost === "0.0.0.0") ||
    (host === "::1" && (endpointHost === "::" || endpointHost === "0:0:0:0:0:0:0:0"))
  );
}

function runExecFile(execFileFn, command, args) {
  return new Promise((resolve, reject) => {
    execFileFn(
      command,
      args,
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

module.exports = {
  assertPortAvailable,
  findPortOwner,
  findWindowsPortOwner,
  parseNetstatOwner,
  parseTasklistCommand,
};
