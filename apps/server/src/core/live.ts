import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DB } from "./db.js";
import {
  registerSession,
  renameSession,
  setSessionDescription,
  getSession,
  heartbeat,
  pruneAbandonedSessions,
  type Session,
} from "./sessions.js";

/**
 * Hook-driven liveness + identity for Claude Code sessions.
 *
 * Claude Code fires shell hooks (SessionStart / UserPromptSubmit / Stop) with
 * the REAL conversation id in stdin JSON. We use that id as the muiltchat
 * session id, so resuming a conversation reactivates the same node, and the
 * first user prompt becomes the node name.
 *
 * The MCP server process (spawned by the same Claude Code process) adopts
 * the hook-registered node by matching the Claude Code process pid, which
 * both sides find by walking their ancestor process chain.
 */

// ---- ancestor walk: find the Claude Code process pid --------------------

const PS_SCRIPT = `param([int]$StartPid)
$p = $StartPid
while ($p -and $p -gt 4) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  if ($proc.CommandLine -match 'claude') { Write-Output $p; exit 0 }
  $p = [int]$proc.ParentProcessId
}
exit 1
`;

let claudePidValue: number | null = null;
let claudePidResolved = false;
let claudePidAttempts = 0;

/**
 * Walk the parent process chain and return the pid of the Claude Code
 * process, or null. Success is cached; failure retries for a bounded
 * number of calls (the hook may fire slightly after the MCP server) and
 * then gives up so we stop paying the walk cost.
 */
export function getClaudePid(): number | null {
  if (claudePidResolved) return claudePidValue;
  if (process.env.MUILTCHAT_CLAUDE_PID) {
    claudePidValue = Number(process.env.MUILTCHAT_CLAUDE_PID) || null;
    claudePidResolved = true;
    return claudePidValue;
  }
  if (++claudePidAttempts > 10) return null;
  try {
    if (process.platform === "win32") {
      const home = join(process.env.USERPROFILE || process.env.HOME || ".", ".muiltchat");
      if (!existsSync(home)) mkdirSync(home, { recursive: true });
      const ps1 = join(home, "find-claude.ps1");
      if (!existsSync(ps1)) writeFileSync(ps1, PS_SCRIPT, "utf8");
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" -StartPid ${process.ppid}`,
        { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (out && /^\d+$/.test(out)) {
        claudePidValue = Number(out);
        claudePidResolved = true;
      }
    } else {
      // POSIX: walk ppid chain, match 'claude' in the command line
      let ppid = process.ppid;
      for (let i = 0; i < 12 && ppid > 1; i++) {
        const line = execSync(`ps -o command= -p ${ppid}`, {
          timeout: 3000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (/claude/i.test(line)) {
          claudePidValue = ppid;
          claudePidResolved = true;
          return claudePidValue;
        }
        const next = execSync(`ps -o ppid= -p ${ppid}`, {
          timeout: 3000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        ppid = Number(next) || 0;
      }
    }
  } catch {
    // unresolved — retry on the next call until the attempt budget runs out
  }
  return claudePidResolved ? claudePidValue : null;
}

// ---- hook event handling --------------------------------------------------

export interface HookPayload {
  session_id: string;
  cwd?: string;
  prompt?: string;
}

function parseMeta(s: Session): Record<string, unknown> {
  if (!s.metadata) return {};
  try {
    return JSON.parse(s.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** First line of the prompt, squeezed to a short display name. */
export function promptExcerpt(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const first = prompt
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 42);
  return first.length > 0 ? first : null;
}

// ---- custom title (/rename) -----------------------------------------------

/** Munge a project dir the way Claude Code does: non-alphanumerics → '-'. */
function mungeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Read the latest /rename title from the session transcript. Claude Code
 * appends `{"type":"custom-title","customTitle":...}` to the jsonl when the
 * user runs /rename. The entry can sit anywhere in the file (renames happen
 * early, transcripts grow large), so we read it whole and scan backwards.
 * Hooks fire once per turn — a multi-MB read (~10ms) is fine there.
 */
export function readCustomTitle(
  sessionId: string,
  cwd?: string | null,
  claudeHome?: string
): string | null {
  const home = claudeHome ?? join(process.env.USERPROFILE || process.env.HOME || ".", ".claude");
  const projectsDir = join(home, "projects");
  const candidates: string[] = [];
  if (cwd) {
    const p = join(projectsDir, mungeProjectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(p)) candidates.push(p);
  }
  try {
    // fallback: the transcript lives in whatever project dir the session
    // started in, which may differ from the hook's cwd
    for (const dir of readdirSync(projectsDir)) {
      const p = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(p) && !candidates.includes(p)) candidates.push(p);
    }
  } catch {
    // projects dir missing — nothing to read
  }
  for (const p of candidates) {
    try {
      const lines = readFileSync(p, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.includes('"custom-title"')) continue;
        try {
          const j = JSON.parse(line) as { type?: string; customTitle?: unknown };
          if (j.type === "custom-title" && typeof j.customTitle === "string" && j.customTitle.trim()) {
            return j.customTitle.replace(/\s+/g, " ").trim().slice(0, 64);
          }
        } catch {
          // malformed line — keep scanning
        }
      }
    } catch {
      // unreadable candidate — try the next
    }
  }
  return null;
}

/**
 * Handle one hook event. The muiltchat session id equals the Claude Code
 * conversation id, so a resumed conversation reactivates its own node.
 */
export function handleHookEvent(
  db: DB,
  event: "session-start" | "prompt" | "stop",
  payload: HookPayload,
  claudeHome?: string
): void {
  if (!payload.session_id) return;
  const id = payload.session_id;
  const existing = getSession(db, id);
  const meta = existing ? parseMeta(existing) : {};
  // Sessions spawned from a runtime-agent preset carry the definition id in
  // their env (set by startRuntimeAgent); stamp it into metadata so the graph
  // can link the node back to its preset.
  const agentTag = (() => {
    const aid = process.env.MUILTCHAT_AGENT_ID;
    if (!aid || Number.isNaN(Number(aid))) return {};
    return {
      agent_id: Number(aid),
      ...(process.env.MUILTCHAT_AGENT_RUNTIME ? { runtime: process.env.MUILTCHAT_AGENT_RUNTIME } : {}),
    };
  })();

  if (event === "stop") {
    if (existing) {
      const title = readCustomTitle(id, payload.cwd ?? existing.project_dir, claudeHome);
      if (title && title !== existing.name) renameSession(db, id, title);
      heartbeat(db, id);
    }
    return;
  }

  if (event === "session-start") {
    // A /rename'd title survives resumes; otherwise keep a prompt-derived
    // name, and only pay the ancestor walk once per conversation.
    const title = readCustomTitle(id, payload.cwd, claudeHome);
    const claudePid = typeof meta.claude_pid === "number" ? meta.claude_pid : getClaudePid();
    registerSession(db, {
      id,
      name:
        title ??
        (typeof meta.named === "boolean" && meta.named && existing
          ? existing.name
          : basename(payload.cwd || "") || "claude"),
      description: meta.named && existing ? existing.description : "Claude Code session (hook)",
      project_dir: payload.cwd ?? existing?.project_dir ?? null,
      metadata: { source: "claude-hook", ...meta, ...agentTag, claude_pid: claudePid },
    });
    // This process previously ran another conversation id that was abandoned
    // by /resume or /clear before receiving any prompt — reap it now.
    if (claudePid !== null) {
      pruneAbandonedSessions(db, { claudePid, keepId: id });
    }
    return;
  }

  // prompt: /rename title wins over the first-prompt excerpt
  const title = readCustomTitle(id, payload.cwd ?? existing?.project_dir ?? null, claudeHome);
  const excerpt = promptExcerpt(payload.prompt);
  if (existing && meta.named && (!title || existing.name === title)) {
    heartbeat(db, id);
    // refresh the "what is this session doing" signal on every turn
    if (excerpt) setSessionDescription(db, id, excerpt);
    return;
  }
  registerSession(db, {
    id,
    name: title ?? excerpt ?? (existing?.name ?? "claude"),
    description: excerpt ?? (existing?.description ?? "Claude Code session (hook)"),
    project_dir: payload.cwd ?? existing?.project_dir ?? null,
    metadata: { source: "claude-hook", ...meta, ...agentTag, named: true },
  });
}

// ---- MCP adoption ----------------------------------------------------------

/**
 * Find the hook-registered session owned by the given Claude Code process.
 * LIKE prefilter + exact JSON check (avoid 123 matching 1234).
 */
export function findSessionByClaudePid(db: DB, pid: number): Session | null {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE metadata LIKE ? AND status = 'active'
       ORDER BY last_heartbeat_at DESC LIMIT 8`
    )
    .all(`%"claude_pid":${pid}%`) as Session[];
  for (const row of rows) {
    if (parseMeta(row).claude_pid === pid) return row;
  }
  return null;
}

/**
 * Delete a session row only if nothing references it (used to clean up the
 * MCP server's temporary uuid node after it adopts the hook-registered one).
 * Hook-registered rows are real conversation identities that survive resumes
 * and may be ask targets later — they are never eligible for cleanup.
 */
export function deleteUnreferencedSession(db: DB, id: string): boolean {
  const res = db
    .prepare(
      `DELETE FROM sessions WHERE id = ? AND
       COALESCE(metadata, '') NOT LIKE '%"source":"claude-hook"%' AND
       (SELECT COUNT(*) FROM messages WHERE from_session = ? OR to_session = ?) = 0 AND
       (SELECT COUNT(*) FROM edges WHERE from_session = ? OR to_session = ?) = 0 AND
       (SELECT COUNT(*) FROM context_entries WHERE session_id = ?) = 0`
    )
    .run(id, id, id, id, id, id);
  return res.changes > 0;
}

/** Read a JSON file tolerantly (used by hooks install/uninstall). */
export function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
