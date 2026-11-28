"use strict";

/**
 * Deterministic Mica CLI shim for bridge tests.
 *
 * Emulates the control-channel contract (list/new-tab/new-window/focus/send/
 * read/badge/watch) so that independent exec invocations behave like one
 * running Mica instance. State lives next to MICA_SHIM_STATE:
 * - <state>.json        panes + watcher registry (written only at moments the
 *                       test serializes: pane creation and watch announce)
 * - <state>.<log>.ndjson append-only records (opens/focuses/sent/badges/events)
 *
 * The split matters: badge/focus/send commands may run as CONCURRENT shim
 * processes (badge auto-sync races interactive commands). Whole-file
 * read-modify-write from two processes loses updates, so anything that can
 * race is append-only; single-line appends don't clobber each other.
 */

const fs = require("node:fs");
const path = require("node:path");

const STATE_PATH = process.env.MICA_SHIM_STATE || "";

const logFile = (name) => `${STATE_PATH}.${name}.ndjson`;

function appendLog(name, record) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.appendFileSync(logFile(name), JSON.stringify(record) + "\n");
}

function readLog(name) {
  try {
    return fs
      .readFileSync(logFile(name), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function argValue(flag) {
  const prefix = `--${flag}=`;
  for (const a of process.argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  const idx = process.argv.indexOf(`--${flag}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

function hasFlag(flag) {
  return process.argv.includes(`--${flag}`);
}

function textAfterSeparator() {
  const idx = process.argv.indexOf("--");
  if (idx < 0) return null;
  return process.argv.slice(idx + 1).join(" ");
}

function loadState() {
  if (!STATE_PATH) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function nextPaneId(panes) {
  return panes.reduce((max, p) => Math.max(max, p.pane_id), 0) + 1;
}

function makePane(panes, paneId, cwd) {
  return {
    window_id: 1,
    tab_index: panes.length,
    pane_id: paneId,
    pid: null,
    cwd: cwd,
    title: `mica-shim-${paneId}`,
    is_active: true,
    is_focused: true,
    is_quick_terminal: false,
    prompt_state: "idle",
    last_exit_code: null,
    badge: null,
  };
}

const command = process.argv[2];

// Optional wedged-control-channel simulation for timeout regression tests:
// hold silence until the caller's exec timeout kills us.
if ((process.env.MICA_SHIM_HANG || "").split(",").filter(Boolean).includes(command)) {
  setInterval(() => {}, 60_000);
} else switch (command) {
  case "list": {
    const state = loadState();
    if (!state) process.exit(1); // no running instance, per contract
    process.stdout.write(JSON.stringify(state.panes) + "\n");
    break;
  }

  case "new-tab":
  case "new-window": {
    let state = loadState();
    if (!state) state = { panes: [], watchers: [] }; // cold start launches the "GUI"
    const cwd = argValue("cwd") || process.cwd();
    const cmdArg = argValue("command");
    const env = {};
    for (let i = 0; i < process.argv.length; i++) {
      if (process.argv[i] === "--env" && i + 1 < process.argv.length) {
        const [k, ...rest] = process.argv[i + 1].split("=");
        if (k === "MICA_PANE_ID") fail("MICA_PANE_ID cannot be overridden");
        env[k] = rest.join("=");
        i++;
      }
    }
    const paneId = nextPaneId(state.panes);
    const pane = makePane(state.panes, paneId, cwd);
    state.panes.push(pane);
    saveState(state);
    appendLog("opens", { mode: command, cwd, command: cmdArg, env });
    appendLog("events", {
      type: "pane_created",
      window_id: pane.window_id,
      tab_index: pane.tab_index,
      pane_id: paneId,
      pid: null,
      cwd,
    });
    process.stdout.write(JSON.stringify(pane) + "\n");
    break;
  }

  case "focus": {
    const state = loadState();
    const paneId = Number(argValue("pane"));
    if (!state?.panes.find((p) => p.pane_id === paneId)) fail("bad_target: pane not found");
    appendLog("focuses", { pane_id: paneId });
    break;
  }

  case "send": {
    const state = loadState();
    const paneId = Number(argValue("pane"));
    const text = textAfterSeparator();
    if (text == null) fail("send requires text after --");
    if (!state?.panes.find((p) => p.pane_id === paneId)) fail("bad_target: pane not found");
    appendLog("sent", { pane_id: paneId, text, literal: hasFlag("literal") });
    break;
  }

  case "read": {
    const state = loadState();
    const paneId = Number(argValue("pane"));
    const pane = state?.panes.find((p) => p.pane_id === paneId);
    if (!pane) fail("bad_target: pane not found");
    const lastSent = [...readLog("sent")].reverse().find((s) => s.pane_id === paneId);
    const lines = Number(argValue("lines") || 0);
    const body = [
      `shim@host:${pane.cwd ?? ""}$ ${lastSent ? lastSent.text : ""}`,
      `simulated screen for pane #${paneId}${hasFlag("scrollback") ? " (scrollback)" : ""}`,
    ].join("\n");
    process.stdout.write(
      JSON.stringify({
        pane_id: paneId,
        cols: 120,
        rows: 30,
        text: body + (lines > 0 ? `\n(lines=${lines})` : ""),
        truncated: false,
      }) + "\n",
    );
    break;
  }

  case "badge": {
    const state = loadState();
    const paneId = Number(argValue("pane"));
    const stateName = argValue("state");
    const text = argValue("text");
    const sticky = hasFlag("sticky");
    if (!state?.panes.find((p) => p.pane_id === paneId)) fail("bad_target: pane not found");
    const badge = { state: stateName, text: text ?? null, sticky };
    appendLog("badges", { pane_id: paneId, ...badge });
    appendLog("events", { type: "badge_changed", pane_id: paneId, badge });
    break;
  }

  case "watch": {
    // Single NDJSON stream over the append-only event log; starts AFTER
    // existing history (only future events, like the real watcher).
    // Liveness is announced through a dedicated beat file so tests can wait
    // for a freshly spawned watcher without racing killed predecessors.
    const beatPath = `${STATE_PATH}.beat`;
    let cursor = readLog("events").length;
    let announced = false;
    const tick = () => {
      const state = loadState();
      if (!state) {
        // Instance gone after we were attached: exit quietly per contract.
        if (announced) process.exit(0);
        setTimeout(tick, 30);
        return;
      }
      if (!announced) {
        state.watchers = state.watchers || [];
        state.watchers.push({ pid: process.pid, at: Date.now() });
        saveState(state);
        announced = true;
      }
      const events = readLog("events");
      for (; cursor < events.length; cursor++) {
        process.stdout.write(JSON.stringify(events[cursor]) + "\n");
      }
      try {
        fs.writeFileSync(beatPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch {
        /* beat is best-effort */
      }
      setTimeout(tick, 30);
    };
    tick();
    break;
  }

  default:
    fail(`unknown or missing command: ${command ?? ""}`);
}
