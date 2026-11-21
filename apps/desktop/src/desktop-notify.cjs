/**
 * Desktop system notifications for cross-session traffic.
 *
 * The hook channel only injects at turn boundaries — a reply can sit unseen
 * for a whole conversation turn. This module polls the local server and
 * raises an OS notification the moment a message lands, giving three layers
 * of visibility: OS notification (instant) → hook injection (turn boundary,
 * full text) → web channel view (browsing).
 */

/** Pure: turn polled messages into notification payloads for ids > lastSeenId.
 *  Questions and replies both notify (either is someone waiting on a human). */
function pickNotifications(messages, lastSeenId) {
  const out = [];
  for (const m of messages) {
    if (typeof m.id !== "number" || m.id <= lastSeenId) continue;
    const from = m.from_name || String(m.from_session).slice(0, 8);
    const to = m.to_name || String(m.to_session).slice(0, 8);
    if (m.reply) {
      out.push({
        id: m.id,
        title: `${to} 回复了 ${from}`,
        body: excerpt(m.reply),
      });
    } else {
      out.push({
        id: m.id,
        title: `${from} → ${to} 提问`,
        body: excerpt(m.question),
      });
    }
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function excerpt(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
}

/**
 * Polling runner. The FIRST poll only records the high-water mark (silent
 * boot — no notification storm for pre-existing history). Later polls raise
 * onNotify({ id, title, body }) for each new message, in id order.
 * Returns a stop() function.
 */
function startMessageNotifications({
  baseUrl,
  fetchFn = globalThis.fetch,
  intervalMs = 10_000,
  requestTimeoutMs = 8_000,
  immediate = true,
  onNotify,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let lastId = -Infinity;
  let stopped = false;
  let polling = false;
  let activeRequest = null;
  const replies = new Map();
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    const controller = new AbortController();
    activeRequest = controller;
    // Cover response-body reads too: a stalled JSON body must not hold the
    // polling lock indefinitely while the service itself remains healthy.
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}/messages?limit=100`, { signal: controller.signal });
      if (!res || !res.ok) return;
      const data = await res.json();
      if (stopped) return;
      const messages = (Array.isArray(data?.messages) ? data.messages : []).filter(m => m && Number.isInteger(m.id));
      if (lastId === -Infinity) {
        // silent boot: adopt the current high-water mark
        lastId = messages.reduce((max, m) => Math.max(max, m.id), 0);
        for (const m of messages) replies.set(m.id, m.reply ?? null);
        return;
      }
      const changed = messages.filter(m => m.id > lastId || (replies.has(m.id) && m.reply && replies.get(m.id) !== m.reply));
      replies.clear();
      for (const m of messages) replies.set(m.id, m.reply ?? null);
      for (const n of pickNotifications(changed, -Infinity)) {
        lastId = Math.max(lastId, n.id);
        onNotify(n);
      }
    } catch {
      // server restarting / network blip — next tick retries
    } finally {
      clearTimeout(timeout);
      if (activeRequest === controller) activeRequest = null;
      polling = false;
    }
  };
  const timer = setIntervalFn(poll, intervalMs);
  if (timer?.unref) timer.unref();
  if (immediate) void poll();
  return () => {
    stopped = true;
    clearIntervalFn(timer);
    activeRequest?.abort();
  };
}

module.exports = { pickNotifications, startMessageNotifications, excerpt };
