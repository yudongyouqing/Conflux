import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { logger } from "../../log.js";

/**
 * tmux injection (#128): if the target session was launched by Conflux inside
 * a tmux session, we can inject a prompt into the RUNNING process — not spawn
 * a headless zombie. The live process handles the message with its CURRENT
 * context, exactly like the user typed it.
 */

export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Convention: Conflux-launched sessions live in tmux sessions named conflux/agent-<id> */
export function tmuxSessionName(agentId: number | string): string {
  return `conflux/agent-${agentId}`;
}

/**
 * Find the tmux session for a Claude session by checking its metadata for
 * the agent_id tag (stamped by startRuntimeAgent's env → hooks → metadata).
 */
export function findTmuxSession(meta: { agent_id?: unknown }): string | null {
  const aid = typeof meta.agent_id === "number" ? meta.agent_id : Number(meta.agent_id);
  if (!Number.isFinite(aid)) return null;
  return tmuxSessionName(aid);
}

/** Check if a tmux session exists for this sessionId and has a live pane */
export function tmuxSessionAlive(sessionId: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", tmuxSessionName(sessionId)], {
      timeout: 3000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inject a prompt into the live process running inside the tmux session.
 * Returns true if injection succeeded.
 */
export function tmuxInject(sessionId: string, prompt: string): boolean {
  if (!tmuxSessionAlive(sessionId)) return false;
  try {
    // Type the prompt, then press Enter — exactly like a human
    execFileSync(
      "tmux",
      ["send-keys", "-t", tmuxSessionName(sessionId), "-l", prompt],
      { timeout: 3000, stdio: "ignore" },
    );
    execFileSync(
      "tmux",
      ["send-keys", "-t", tmuxSessionName(sessionId), "Enter"],
      { timeout: 3000, stdio: "ignore" },
    );
    logger.info({ sessionId }, "tmux inject: prompt delivered to live process");
    return true;
  } catch (err) {
    logger.warn(
      { sessionId, err: err instanceof Error ? err.message : err },
      "tmux inject failed",
    );
    return false;
  }
}

/**
 * Launch a session inside tmux so it's injectable later.
 * The tmux session is named conflux/<sessionId> for lookup.
 */
export function tmuxLaunch(
  sessionId: string,
  command: string,
  cwd?: string,
): { ok: boolean; sessionName: string } {
  const sessionName = tmuxSessionName(sessionId);
  try {
    const args = ["new-session", "-d", "-s", sessionName];
    if (cwd) args.push("-c", cwd);
    args.push(command);
    execFileSync("tmux", args, { timeout: 5000, stdio: "ignore" });
    logger.info({ sessionId, sessionName }, "tmux session launched");
    return { ok: true, sessionName };
  } catch (err) {
    logger.warn(
      { sessionId, err: err instanceof Error ? err.message : err },
      "tmux launch failed",
    );
    return { ok: false, sessionName };
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

/** claude_pid → controlling tty → tmux pane, foreground-verified. */
export function paneForPid(pid: number): string | null {
  try {
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], {
      timeout: 2000,
    })
      .toString()
      .trim();
    if (!tty || tty === "?" || tty === "??") return null;
    const comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 2000 })
      .toString()
      .trim();
    const list = execFileSync(
      "tmux",
      ["list-panes", "-a", "-F", "#{pane_id} #{pane_tty} #{pane_current_command}"],
      { timeout: 2000 },
    ).toString();
    return parsePaneList(list, tty, comm);
  } catch {
    // ps missing (Windows), process gone, or tmux has no panes — unreachable
    return null;
  }
}

/** Default implementation over the real tmux/ps binaries. */
export const realTmuxIO: TmuxIO = {
  available: tmuxAvailable,
  alive: (name) => {
    try {
      execFileSync("tmux", ["has-session", "-t", name], { timeout: 3000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  paneForPid,
  send: (target, text) => {
    try {
      execFileSync("tmux", ["send-keys", "-t", target, "-l", text], {
        timeout: 3000,
        stdio: "ignore",
      });
      execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
        timeout: 3000,
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
      return execFileSync("tmux", ["capture-pane", "-p", "-t", target], { timeout: 2000 }).toString();
    } catch {
      return "";
    }
  },
};
