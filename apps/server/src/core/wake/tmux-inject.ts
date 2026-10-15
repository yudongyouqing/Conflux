import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { logger } from "../../log.js";

/**
 * tmux typed delivery (#128 live injection, #162 typed mail): one IO layer
 * (realTmuxIO) plus the name conventions and pure parsing around it. If the
 * target session was launched by Conflux inside tmux — or the user runs it
 * in their own tmux — we can inject a prompt into the RUNNING process: the
 * text lands in the TUI exactly like the user typed it.
 */

/** Convention: Conflux-launched agents live in tmux sessions named conflux/agent-<id>. */
export function tmuxSessionName(agentId: number | string): string {
  return `conflux/agent-${agentId}`;
}

export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { timeout: 1000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---- typed delivery IO (#162) --------------------------------------------------

/** Every process-touching tmux/ps operation, injectable for tests. */
export interface TmuxIO {
  /** tmux binary usable on this machine at all */
  available(): boolean;
  /** does a tmux session with this exact name exist */
  alive(name: string): boolean;
  /**
   * Find the tmux pane whose foreground process is the given pid — the
   * user's own terminal session (claude launched by hand inside tmux).
   * Returns the pane id ("%3") or null when unreachable.
   */
  paneForPid(pid: number): string | null;
  /** type text into a tmux target (session name or pane id) + press Enter */
  send(target: string, text: string): boolean;
  /** start a detached tmux session running command */
  launch(opts: { name: string; command: string; cwd?: string | null }): boolean;
  /** current visible text of a pane — boot-readiness probing */
  capture(target: string): string;
}

/**
 * Match a `tmux list-panes -a -F "#{pane_id} #{pane_tty} #{pane_current_command}"`
 * listing against a ps-reported tty + comm. The foreground-command guard is
 * the safety net: if the pane's foreground is NOT the target process (claude
 * suspended, a shell or editor in front), typing there could hit the wrong
 * program — refuse instead.
 */
export function parsePaneList(
  listOutput: string,
  tty: string,
  expectedComm: string,
): string | null {
  const wantTty = tty.replace(/^\/dev\//, "");
  const wantComm = basename(expectedComm).toLowerCase();
  if (!wantTty || !wantComm || wantTty === "?") return null;
  for (const line of listOutput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [paneId, paneTty, paneComm] = fields;
    if (paneTty.replace(/^\/dev\//, "") !== wantTty) continue;
    if (paneComm.toLowerCase() !== wantComm) return null; // tty hit, wrong foreground
    return paneId;
  }
  return null;
}

/**
 * Default implementation over the real tmux/ps binaries. Timeouts stay
 * short (1s): these run inline on the ask/reply hot path — a wedged tmux
 * server must not stall the single-threaded server for seconds.
 */
export const realTmuxIO: TmuxIO = {
  available: tmuxAvailable,
  alive: (name) => {
    try {
      execFileSync("tmux", ["has-session", "-t", name], { timeout: 1000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  paneForPid(pid) {
    try {
      const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { timeout: 1000 })
        .toString()
        .trim();
      if (!tty || tty === "?" || tty === "??") return null;
      const comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 1000 })
        .toString()
        .trim();
      const list = execFileSync(
        "tmux",
        ["list-panes", "-a", "-F", "#{pane_id} #{pane_tty} #{pane_current_command}"],
        { timeout: 1000 },
      ).toString();
      return parsePaneList(list, tty, comm);
    } catch {
      // ps missing (Windows), process gone, or tmux has no panes — unreachable
      return null;
    }
  },
  send: (target, text) => {
    try {
      execFileSync("tmux", ["send-keys", "-t", target, "-l", text], {
        timeout: 1000,
        stdio: "ignore",
      });
      execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
        timeout: 1000,
        stdio: "ignore",
      });
      return true;
    } catch (err) {
      logger.warn({ target, err: err instanceof Error ? err.message : err }, "tmux send failed");
      return false;
    }
  },
  launch: (opts) => {
    try {
      const args = ["new-session", "-d", "-s", opts.name];
      if (opts.cwd) args.push("-c", opts.cwd);
      args.push(opts.command);
      execFileSync("tmux", args, { timeout: 5000, stdio: "ignore" });
      logger.info({ name: opts.name }, "tmux session launched");
      return true;
    } catch (err) {
      logger.warn(
        { name: opts.name, err: err instanceof Error ? err.message : err },
        "tmux launch failed",
      );
      return false;
    }
  },
  capture: (target) => {
    try {
      return execFileSync("tmux", ["capture-pane", "-p", "-t", target], {
        timeout: 1000,
      }).toString();
    } catch {
      return "";
    }
  },
};

// ---- legacy helper forms over the IO layer -------------------------------------

/** Alive check by Conflux session id (agent id). */
export function tmuxSessionAlive(sessionId: string): boolean {
  return realTmuxIO.alive(tmuxSessionName(sessionId));
}

/**
 * Type a prompt into a Conflux-managed tmux session (by agent id) —
 * room orchestration's injection entry point. Returns true if delivered.
 */
export function tmuxInject(sessionId: string, prompt: string): boolean {
  const name = tmuxSessionName(sessionId);
  if (!realTmuxIO.alive(name)) return false;
  if (!realTmuxIO.send(name, prompt)) return false;
  logger.info({ sessionId }, "tmux inject: prompt delivered to live process");
  return true;
}
