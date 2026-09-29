import { execFileSync } from "node:child_process";
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
