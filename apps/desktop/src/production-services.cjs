const { spawn } = require("node:child_process");
const { waitForHttp, stopChild } = require("./dev-services.cjs");

const PRODUCTION_HOST = "127.0.0.1";
const PRODUCTION_PORT = 9527;
const PRODUCTION_HEALTH_URL = `http://${PRODUCTION_HOST}:${PRODUCTION_PORT}/healthz`;

function createProductionServiceSpec(
  { serverEntry, webDist, dataDir },
  { execPath = process.execPath, env = process.env } = {}
) {
  const childEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    MUILTCHAT_WEB_DIST: webDist,
    MUILTCHAT_HOST: PRODUCTION_HOST,
    MUILTCHAT_PORT: String(PRODUCTION_PORT),
  };
  if (dataDir) childEnv.MUILTCHAT_HOME = dataDir;

  return {
    name: "server",
    command: execPath,
    args: [serverEntry, "serve"],
    env: childEnv,
    url: PRODUCTION_HEALTH_URL,
  };
}

function waitForProductionService(
  spec,
  child,
  { timeoutMs = 30_000, intervalMs = 100, signal, waitForHttpFn = waitForHttp } = {}
) {
  const healthController = new AbortController();

  return new Promise((resolve, reject) => {
    let settled = false;
    let childExited = false;
    let readyTimer;

    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (readyTimer) clearImmediate(readyTimer);
      healthController.abort();
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const onAbort = () => {
      finish(reject, new Error(`Aborted waiting for ${spec.url}`));
    };

    const onError = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      finish(reject, new Error(`${spec.name} failed to start: ${message}`));
    };

    const onExit = (code, exitSignal) => {
      childExited = true;
      const reason = exitSignal
        ? `signal ${exitSignal}`
        : `code ${code ?? "unknown"}`;
      finish(
        reject,
        new Error(`${spec.name} exited before becoming ready (${reason})`)
      );
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

    waitForHttpFn(spec.url, {
      timeoutMs,
      intervalMs,
      signal: healthController.signal,
    })
      .then(() => {
        if (childExited || (child.exitCode !== null && child.exitCode !== undefined)) {
          onExit(child.exitCode, null);
          return;
        }
        // Let an already-queued child exit event run before declaring the
        // service ready. This closes the health-response/exit race window.
        readyTimer = setImmediate(() => {
          readyTimer = undefined;
          if (childExited || (child.exitCode !== null && child.exitCode !== undefined)) {
            onExit(child.exitCode, null);
            return;
          }
          finish(resolve);
        });
      })
      .catch((error) => finish(reject, error));
  });
}

async function startProductionService(paths, options = {}) {
  const {
    spawnFn = spawn,
    timeoutMs,
    intervalMs,
    signal,
    execPath,
    env,
  } = options;
  const spec = createProductionServiceSpec(paths, { execPath, env });
  const child = spawnFn(spec.command, spec.args, {
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    await waitForProductionService(spec, child, { timeoutMs, intervalMs, signal });
    return { spec, child };
  } catch (error) {
    stopChild(child);
    throw error;
  }
}

module.exports = {
  PRODUCTION_HOST,
  PRODUCTION_PORT,
  PRODUCTION_HEALTH_URL,
  createProductionServiceSpec,
  waitForProductionService,
  startProductionService,
  stopProductionService: stopChild,
};
