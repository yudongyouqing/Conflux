const http = require("node:http");
const { spawn } = require("node:child_process");
const { assertPortAvailable } = require("./port-diagnostics.cjs");

const API_HEALTH_URL = "http://127.0.0.1:9527/healthz";
const WEB_URL = "http://127.0.0.1:5173/";
const DEV_SERVICE_STARTUP_TIMEOUT_MS = 120_000;

function createNpmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
} = {}) {
  if (platform === "win32" && npmExecPath) {
    return { command: execPath, args: [npmExecPath], shell: false };
  }
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: [],
    shell: platform === "win32",
  };
}

function createDevServiceSpecs(repoRoot, options = {}) {
  const invocation = createNpmInvocation(options);
  return [
    {
      name: "server",
      command: invocation.command,
      args: [...invocation.args, "run", "serve", "-w", "apps/server"],
      shell: invocation.shell,
      cwd: repoRoot,
      host: "127.0.0.1",
      port: 9527,
      url: API_HEALTH_URL,
      startupTimeoutMs: DEV_SERVICE_STARTUP_TIMEOUT_MS,
    },
    {
      name: "web",
      command: invocation.command,
      args: [
        ...invocation.args,
        "run",
        "dev",
        "-w",
        "apps/web",
        "--",
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
      shell: invocation.shell,
      cwd: repoRoot,
      host: "127.0.0.1",
      port: 5173,
      url: WEB_URL,
      startupTimeoutMs: DEV_SERVICE_STARTUP_TIMEOUT_MS,
    },
  ];
}

async function assertDevServicePorts(
  specs,
  { assertPortAvailableFn = assertPortAvailable } = {}
) {
  for (const spec of specs) {
    await assertPortAvailableFn(spec.port, spec.host);
  }
}

function createDevServiceSpawnOptions(
  cwd,
  env = process.env,
  shell = process.platform === "win32"
) {
  return {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // npm.cmd fallback needs cmd.exe; direct npm CLI launches do not.
    shell,
    windowsHide: true,
  };
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
  {
    timeoutMs = 30_000,
    intervalMs = 100,
    exitProbeTimeoutMs = 250,
    signal,
  } = {}
) {
  const controller = new AbortController();
  const exitProbeController = new AbortController();

  return new Promise((resolve, reject) => {
    let settled = false;
    let childExited = false;

    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      exitProbeController.abort();
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

    const onAbort = () => {
      finish(reject, new Error(`Aborted waiting for ${spec.name}`));
    };

    const onExit = (code, exitSignal) => {
      childExited = true;
      controller.abort();
      waitForHttp(spec.url, {
        timeoutMs: exitProbeTimeoutMs,
        intervalMs: Math.min(intervalMs, 25),
        signal: exitProbeController.signal,
      })
        .then(() => finish(resolve))
        .catch(() => {
          const reason = exitSignal
            ? `signal ${exitSignal}`
            : `code ${code ?? "unknown"}`;
          finish(
            reject,
            new Error(`${spec.name} exited before becoming ready (${reason})`)
          );
        });
    };

    child.once("error", onError);
    child.once("exit", onExit);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

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

function stopChild(child, { platform = process.platform, spawnFn = spawn } = {}) {
  if (!child) return Promise.resolve();
  if (stoppingChildren.has(child)) return stoppingChildren.get(child);

  if (platform === "win32" && child.pid) {
    const stopping = new Promise((resolve) => {
      const killer = spawnFn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" }
      );
      if (!killer?.once) {
        resolve();
        return;
      }
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    stoppingChildren.set(child, stopping);
    return stopping;
  }

  if (!child.killed && (child.exitCode === null || child.exitCode === undefined)) {
    child.kill("SIGTERM");
  }
  const stopping = Promise.resolve();
  stoppingChildren.set(child, stopping);
  return stopping;
}

function createServiceRuntimeGuard({
  isServicesReady = () => false,
  isQuitting = () => false,
  onFailure = () => {},
} = {}) {
  let failureHandled = false;

  function report(failure) {
    if (failureHandled || !isServicesReady() || isQuitting()) {
      return false;
    }
    failureHandled = true;
    onFailure(failure);
    return true;
  }

  function handleChildExit(spec, code, signal) {
    const reason = signal
      ? `signal ${signal}`
      : `code ${code ?? "unknown"}`;
    return report({
      type: "child-exit",
      name: spec.name,
      reason,
    });
  }

  function handleChildError(spec, error) {
    const reason = error instanceof Error ? error.message : String(error);
    return report({
      type: "child-error",
      name: spec.name,
      reason,
    });
  }

  function handleHealthState(snapshot) {
    if (snapshot?.state !== "unhealthy") {
      return false;
    }
    return report({
      type: "health",
      name: snapshot.name,
      reason: "health state unhealthy",
    });
  }

  return {
    handleChildExit,
    handleChildError,
    handleHealthState,
    hasFailed: () => failureHandled,
  };
}

const stoppingChildren = new WeakMap();

module.exports = {
  API_HEALTH_URL,
  WEB_URL,
  createDevServiceSpecs,
  createDevServiceSpawnOptions,
  assertDevServicePorts,
  waitForService,
  waitForHttp,
  stopChild,
  createServiceRuntimeGuard,
};
