const http = require("node:http");
const https = require("node:https");

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_HTTP_TIMEOUT_MS = 2_000;

function createServiceHealthMonitor(options = {}) {
  const name = options.name ?? "service";
  const probe = options.probe;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const failureThreshold = Math.max(
    1,
    Math.floor(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)
  );
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const now = options.now ?? (() => Date.now());
  const onStateChange = options.onStateChange ?? (() => {});

  if (typeof probe !== "function") {
    throw new TypeError("service health probe must be a function");
  }

  let state = "starting";
  let consecutiveFailures = 0;
  let lastCheckedAt = null;
  let reason = null;
  let errorMessage = null;
  let timer = null;
  let timerStarted = false;
  let running = false;
  let pendingProbe = null;

  function snapshot() {
    return {
      name,
      state,
      consecutiveFailures,
      lastCheckedAt,
      reason,
      error: errorMessage,
    };
  }

  function emitState(nextState, nextReason, nextError = null) {
    const changed = state !== nextState;
    state = nextState;
    reason = nextReason;
    errorMessage = nextError;
    if (changed) {
      onStateChange(snapshot());
    }
  }

  function applyProbeResult(success, error) {
    if (!running) {
      return snapshot();
    }

    lastCheckedAt = now();
    if (success) {
      const recovered = state === "degraded" || state === "unhealthy";
      consecutiveFailures = 0;
      emitState("healthy", recovered ? "probe-recovered" : "probe-success");
      return snapshot();
    }

    consecutiveFailures += 1;
    const nextState = consecutiveFailures >= failureThreshold
      ? "unhealthy"
      : "degraded";
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    emitState(nextState, "probe-failed", message);
    return snapshot();
  }

  function tick() {
    if (!running) {
      return Promise.resolve(snapshot());
    }
    if (pendingProbe) {
      return pendingProbe;
    }

    const pending = Promise.resolve()
      .then(() => probe())
      .then(
        (result) => applyProbeResult(result === true, null),
        (error) => applyProbeResult(false, error)
      )
      .finally(() => {
        if (pendingProbe === pending) {
          pendingProbe = null;
        }
      });
    pendingProbe = pending;
    return pending;
  }

  function start() {
    if (running) {
      return pendingProbe ?? Promise.resolve(snapshot());
    }

    running = true;
    state = "starting";
    consecutiveFailures = 0;
    lastCheckedAt = null;
    reason = null;
    errorMessage = null;
    timer = setIntervalFn(tick, intervalMs);
    timerStarted = true;
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    return tick();
  }

  function stop() {
    running = false;
    if (timerStarted) {
      clearIntervalFn(timer);
      timer = null;
      timerStarted = false;
    }
    emitState("stopped", "stopped");
    return snapshot();
  }

  return {
    start,
    stop,
    tick,
    snapshot,
  };
}

function probeHttp(url, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const client = String(url).startsWith("https:") ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    let request;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      request = client.get(url, (response) => {
        const statusCode = response.statusCode ?? 0;
        response.resume();
        finish(statusCode >= 200 && statusCode < 400);
      });
      request.once("error", () => finish(false));
      request.setTimeout(timeoutMs, () => {
        finish(false);
        request.destroy();
      });
    } catch {
      if (request) request.destroy();
      finish(false);
    }
  });
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT_MS,
  createServiceHealthMonitor,
  probeHttp,
};
