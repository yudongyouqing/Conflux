const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function createRendererWatchdog(options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const sendPing = options.sendPing ?? (() => {});
  const onStateChange = options.onStateChange ?? (() => {});

  let state = "starting";
  let timer = null;
  let startedAt = null;
  let lastPingAt = null;
  let lastPongAt = null;
  let lastSentNonce = null;
  let nextNonce = 0;
  let details = null;

  function snapshot() {
    return {
      state,
      startedAt,
      lastPingAt,
      lastPongAt,
      lastSentNonce,
      reason: details?.reason ?? null,
      details,
    };
  }

  function emitState(nextState, nextDetails = null) {
    const changed = state !== nextState;
    state = nextState;
    details = nextDetails;
    if (changed) {
      onStateChange(snapshot());
    }
  }

  function isRunning() {
    return timer !== null;
  }

  function sendNextPing() {
    const sentAt = now();
    const nonce = ++nextNonce;
    lastSentNonce = nonce;
    lastPingAt = sentAt;
    sendPing({ nonce, sentAt });
  }

  function start() {
    if (isRunning()) {
      return snapshot();
    }

    state = "starting";
    details = null;
    startedAt = now();
    lastPingAt = null;
    lastPongAt = null;
    lastSentNonce = null;
    sendNextPing();
    timer = setIntervalFn(tick, intervalMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    onStateChange(snapshot());
    return snapshot();
  }

  function stop() {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    if (state !== "stopped") {
      emitState("stopped");
    }
    return snapshot();
  }

  function tick() {
    if (!isRunning()) {
      return snapshot();
    }

    const referenceAt = lastPongAt ?? startedAt;
    if (referenceAt !== null && now() - referenceAt >= timeoutMs) {
      emitState("unknown", { reason: "pong-timeout" });
    }
    sendNextPing();
    return snapshot();
  }

  function handlePong(payload) {
    if (!isRunning() || !payload || !Number.isInteger(payload.nonce)) {
      return false;
    }
    if (payload.nonce <= 0 || payload.nonce !== lastSentNonce) {
      return false;
    }

    lastPongAt = now();
    emitState("responsive", { reason: "pong" });
    return true;
  }

  function markUnresponsive(eventDetails = { reason: "unresponsive" }) {
    if (isRunning()) {
      emitState("unknown", eventDetails);
    }
    return snapshot();
  }

  function markResponsive(eventDetails = { reason: "responsive" }) {
    if (isRunning()) {
      lastPongAt = now();
      emitState("responsive", eventDetails);
    }
    return snapshot();
  }

  function markCrashed(eventDetails = { reason: "render-process-gone" }) {
    if (isRunning()) {
      emitState("crashed", eventDetails);
    }
    return snapshot();
  }

  return {
    start,
    stop,
    handlePong,
    markUnresponsive,
    markResponsive,
    markCrashed,
    tick,
    snapshot,
  };
}

module.exports = { createRendererWatchdog };
