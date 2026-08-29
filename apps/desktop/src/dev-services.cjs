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
      args: [
        "run",
        "dev",
        "-w",
        "apps/web",
        "--",
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
      cwd: repoRoot,
      url: WEB_URL,
    },
  ];
}

function waitForHttp(
  url,
  { timeoutMs = 30_000, intervalMs = 100, signal } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let timer;
  let request;

  return new Promise((resolve, reject) => {
    let settled = false;

    const abort = () => {
      finish(reject, new Error(`Aborted waiting for ${url}`));
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (request) request.destroy();
      signal?.removeEventListener("abort", abort);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
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

      request = http.get(url, (response) => {
        response.resume();
        request = undefined;
        finish(resolve);
      });
      request.once("error", retry);
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    attempt();
  });
}

function waitForService(
  spec,
  child,
  { timeoutMs = 30_000, intervalMs = 100, exitProbeTimeoutMs = 250 } = {}
) {
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    let settled = false;
    let childExited = false;

    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      controller.abort();
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const onError = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      finish(reject, new Error(`${spec.name} failed to start: ${message}`));
    };

    const onExit = (code, signal) => {
      childExited = true;
      controller.abort();
      waitForHttp(spec.url, {
        timeoutMs: exitProbeTimeoutMs,
        intervalMs: Math.min(intervalMs, 25),
      })
        .then(() => finish(resolve))
        .catch(() => {
          const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
          finish(
            reject,
            new Error(`${spec.name} exited before becoming ready (${reason})`)
          );
        });
    };

    child.once("error", onError);
    child.once("exit", onExit);

    if (child.exitCode !== null && child.exitCode !== undefined) {
      onExit(child.exitCode, null);
      return;
    }

    waitForHttp(spec.url, {
      timeoutMs,
      intervalMs,
      signal: controller.signal,
    })
      .then(() => {
        if (!childExited) finish(resolve);
      })
      .catch((error) => {
        if (!childExited) finish(reject, error);
      });
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
  waitForService,
  waitForHttp,
  stopChild,
};
