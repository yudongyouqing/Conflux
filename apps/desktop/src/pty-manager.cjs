/**
 * Lightweight PTY manager (#130): spawn runtime agents in Conflux-owned
 * pseudo-terminals. We hold the master fd — stdout streams to the desktop
 * panel (plain text, no terminal emulation), and wake injection writes
 * directly to the PTY without tmux.
 */
const pty = require("node-pty");

const ptys = new Map(); // agentId → { process, buffer, listeners }

function spawnAgent(agentId, command, args, opts = {}) {
  if (ptys.has(agentId)) return ptys.get(agentId);

  const term = process.platform === "win32" ? "cmd.exe" : "/bin/zsh";
  const cwd = opts.cwd || process.env.HOME;

  const ptyProcess = pty.spawn(command, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env, ...opts.env },
  });

  const entry = {
    process: ptyProcess,
    buffer: "",
    listeners: new Set(),
    pid: ptyProcess.pid,
  };
  ptys.set(agentId, entry);

  ptyProcess.onData((data) => {
    entry.buffer += data;
    if (entry.buffer.length > 100_000) entry.buffer = entry.buffer.slice(-50_000);
    for (const fn of entry.listeners) fn(data, entry.buffer);
  });

  ptyProcess.onExit(({ exitCode }) => {
    ptys.delete(agentId);
    for (const fn of entry.listeners) fn(null, entry.buffer + `\n[exited ${exitCode}]`);
  });

  return entry;
}

/** Inject a prompt into the live process — the whole point of holding master fd */
function inject(agentId, text) {
  const entry = ptys.get(agentId);
  if (!entry) return false;
  try {
    entry.process.write(text + "\r");
    return true;
  } catch {
    return false;
  }
}

function getBuffer(agentId) {
  return ptys.get(agentId)?.buffer ?? null;
}

function subscribe(agentId, callback) {
  const entry = ptys.get(agentId);
  if (!entry) return () => {};
  entry.listeners.add(callback);
  return () => entry.listeners.delete(callback);
}

function isAlive(agentId) {
  return ptys.has(agentId);
}

function kill(agentId) {
  const entry = ptys.get(agentId);
  if (!entry) return;
  try { entry.process.kill(); } catch { /* already dead */ }
  ptys.delete(agentId);
}

module.exports = { spawnAgent, inject, getBuffer, subscribe, isAlive, kill };
