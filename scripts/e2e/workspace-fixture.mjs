import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import services from "../../apps/desktop/src/dev-services.cjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

export async function withWorkspaceFixture(run, { serverPort = 19527, webPort = 5199, seedFlags = [] } = {}) {
  await Promise.all([assertPortAvailable(serverPort), assertPortAvailable(webPort)]);
  const home = mkdtempSync(join(tmpdir(), "conflux-e2e-"));
  const children = [];
  const logs = {};
  const api = `http://127.0.0.1:${serverPort}`;
  const web = `http://127.0.0.1:${webPort}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CONFLUX_|VITE_API_)/i.test(key)),
  );
  function launch(name, args, cwd, overrides) {
    logs[name] = "";
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...env, ...overrides },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    children.push(child);
    child.stderr.on("data", (chunk) => {
      logs[name] = (logs[name] + chunk.toString()).slice(-8000);
    });
    return child;
  }

  try {
    execFileSync(process.execPath, ["scripts/capture/seed-fixture.mjs", home, ...seedFlags], {
      cwd: ROOT,
      env: { ...env, CONFLUX_LOG_FILE: join(home, "server.log") },
      stdio: "inherit",
    });
    const server = launch("server", ["--import", "tsx", "apps/server/src/index.ts", "serve"], ROOT, {
      CONFLUX_HOME: home,
      CONFLUX_HOST: "127.0.0.1",
      CONFLUX_PORT: String(serverPort),
      CONFLUX_PEER_TTL_MS: "600000",
      CONFLUX_LOG_FILE: join(home, "server.log"),
    });
    const vite = launch(
      "web",
      [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"],
      join(ROOT, "apps/web"),
      { VITE_API_TARGET: api },
    );
    await Promise.all([
      services.waitForService({ name: "fixture server", url: api + "/healthz" }, server),
      services.waitForService({ name: "fixture web", url: web }, vite),
    ]);
    const request = async (path, { method = "GET", body, status = 200 } = {}) => {
      const response = await fetch(api + path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    };
    return await run({ web, request });
  } catch (error) {
    console.error(JSON.stringify(logs, null, 2));
    throw error;
  } finally {
    await Promise.all(children.map((child) => services.stopChild(child)));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
