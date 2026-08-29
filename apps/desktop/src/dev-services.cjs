const http = require("node:http");
const { spawn } = require("node:child_process");

const API_HEALTH_URL = "http://127.0.0.1:9527/healthz";
const WEB_URL = "http://127.0.0.1:5173/";

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function createDevServiceSpecs(repoRoot) {
  const command = npmCommand();
  return [
    {
      name: "server",
      command,
      args: ["run", "serve", "-w", "apps/server"],
      cwd: repoRoot,
      url: API_HEALTH_URL,
    },
    {
      name: "web",
      command,
      args: ["run", "dev", "-w", "apps/web", "--", "--host", "127.0.0.1"],
      cwd: repoRoot,
      url: WEB_URL,
    },
  ];
}

function waitForHttp(url, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let timer;
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };

    const retry = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finish(reject, new Error(`Timed out waiting for ${url}`));
        return;
      }
      timer = setTimeout(attempt, intervalMs);
    };

    const attempt = () => {
      if (settled) return;

      const request = http.get(url, (response) => {
        response.resume();
        finish(resolve);
      });
      request.once("error", retry);
    };

    attempt();
  });
}

function stopChild(child) {
  if (!child || child.killed || (child.exitCode !== null && child.exitCode !== undefined)) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  child.kill("SIGTERM");
}

module.exports = {
  API_HEALTH_URL,
  WEB_URL,
  createDevServiceSpecs,
  waitForHttp,
  stopChild,
};
