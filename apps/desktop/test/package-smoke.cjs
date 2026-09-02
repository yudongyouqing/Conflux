const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { listPackage } = require("@electron/asar");

function requiredFile(filePath, label) {
  assert.ok(fs.existsSync(filePath), `${label} is missing: ${filePath}`);
  return filePath;
}

function normalizeEntry(entry) {
  return entry.replaceAll("\\", "/").replace(/^\/+/, "");
}

function assertPackageLayout(packageDir) {
  const asarPath = requiredFile(
    path.join(packageDir, "resources", "app.asar"),
    "app.asar"
  );
  const entries = new Set(listPackage(asarPath).map(normalizeEntry));

  for (const entry of [
    "apps/desktop/src/main.cjs",
    "apps/server/dist/index.js",
    "apps/web/dist/index.html",
    "node_modules/fastify",
    "node_modules/@modelcontextprotocol/sdk",
    "node_modules/@muiltchat/shared",
  ]) {
    assert.ok(
      entries.has(entry) || [...entries].some((candidate) => candidate.startsWith(`${entry}/`)),
      `asar entry is missing: ${entry}`
    );
  }

  const nativePath = requiredFile(
    path.join(
      packageDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node"
    ),
    "better-sqlite3 native module"
  );

  return { asarPath, nativePath };
}

function request(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode, body });
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(url, child) {
  let spawnError;
  const onError = (error) => {
    spawnError = error;
  };
  child.once("error", onError);

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`failed to start packaged server: ${spawnError.message}`);
      }
      if (child.exitCode !== null) {
        throw new Error(`packaged server exited with code ${child.exitCode}`);
      }
      try {
        const response = await request(url);
        if (response.status === 200) {
          await delay(100);
          if (child.exitCode !== null) {
            throw new Error(`health response came from another process; packaged server exited with code ${child.exitCode}`);
          }
          return response;
        }
      } catch (error) {
        if (error.message.startsWith("health response came from another process")) {
          throw error;
        }
      }
      await delay(100);
    }
    throw new Error(`packaged server health check timed out: ${url}`);
  } finally {
    child.removeListener("error", onError);
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;

  const exitPromise = waitForExit(child);
  child.kill();
  let exit = await Promise.race([exitPromise, delay(5_000).then(() => null)]);

  if (!exit && child.exitCode === null && process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    exit = await Promise.race([exitPromise, delay(2_000).then(() => null)]);
  }

  assert.ok(exit || child.exitCode !== null, "packaged server did not exit");
}

async function run() {
  assert.equal(process.platform, "win32", "package smoke requires a Windows build");

  const packageDir = path.resolve(
    process.env.CONFLUX_PACKAGE_DIR || path.join("release", "win-unpacked")
  );
  const { asarPath, nativePath } = assertPackageLayout(packageDir);
  const configuredPort = process.env.CONFLUX_PACKAGE_SMOKE_PORT;
  const port = configuredPort === undefined
    ? await findFreePort()
    : Number.parseInt(configuredPort, 10);
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65_536, "invalid smoke port");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflux-package-smoke-"));
  const executable = requiredFile(path.join(packageDir, "Conflux.exe"), "Conflux executable");
  const serverEntry = path.join(packageDir, "resources", "app.asar", "apps", "server", "dist", "index.js");
  const webDist = path.join(packageDir, "resources", "app.asar", "apps", "web", "dist");
  const child = spawn(executable, [serverEntry, "serve"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MUILTCHAT_HOME: dataDir,
      MUILTCHAT_HOST: "127.0.0.1",
      MUILTCHAT_PORT: String(port),
      MUILTCHAT_WEB_DIST: webDist,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    assert.deepEqual(JSON.parse(health.body), { ok: true }, "packaged health response is invalid");
    const root = await request(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200, "packaged web root did not respond with 200");
    assert.match(root.body, /<div id="root"/, "packaged web root is not the Conflux frontend");
    console.log(JSON.stringify({ asarPath, nativePath, health: health.status, root: root.status }));
  } finally {
    await stopProcess(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
