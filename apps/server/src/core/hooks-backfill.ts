import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, platform } from "node:os";

/**
 * Backfill for sessions that were already running when hooks got installed:
 * such sessions never saw SessionStart, so nothing registered them and the
 * graph looks empty even though claude/codex processes are alive. We match
 * live runtime pids against recent transcript files (cwd equality + timeline
 * "transcript activity after process start") and register the winners
 * through the same registerSession path SessionStart uses.
 *
 * Verified by hand on 2026-09-20 before this module existed (issue #75).
 */

export interface BackfillCandidate {
  sessionId: string;
  transcriptPath: string;
  projectDir: string | null;
  lastActivityMs: number | null;
  firstPrompt: string | null;
}

// ---- candidate parsing ------------------------------------------------------

/**
 * Parse one Claude Code transcript into a backfill candidate. Pure: text in,
 * candidate out. Malformed lines are skipped; the cwd field of any entry
 * names the project dir; the last timestamp wins for activity.
 */
export function parseTranscriptCandidate(
  text: string,
  transcriptPath: string,
): BackfillCandidate {
  let projectDir: string | null = null;
  let firstPrompt: string | null = null;
  let lastActivityMs: number | null = null;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let j: {
      cwd?: unknown;
      timestamp?: unknown;
      type?: unknown;
      message?: { content?: unknown };
    };
    try {
      j = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip
    }
    if (projectDir === null && typeof j.cwd === "string" && j.cwd) projectDir = j.cwd;
    if (typeof j.timestamp === "string") {
      const t = Date.parse(j.timestamp);
      if (!Number.isNaN(t)) lastActivityMs = t;
    }
    if (firstPrompt === null && j.type === "user") {
      const c = j.message?.content;
      let textContent: string | null = null;
      if (typeof c === "string") textContent = c;
      else if (Array.isArray(c)) {
        const parts = c
          .filter(
            (p): p is { type: "text"; text: string } =>
              !!p &&
              typeof p === "object" &&
              (p as { type?: unknown }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => p.text);
        if (parts.length > 0) textContent = parts.join(" ");
      }
      if (textContent) {
        const t = textContent.trim();
        // '<'-prefixed entries are command wrappers (/rename etc.), not prose
        if (t && !t.startsWith("<")) firstPrompt = t;
      }
    }
  }
  return {
    sessionId: basename(transcriptPath).replace(/\.jsonl$/, ""),
    transcriptPath,
    projectDir,
    lastActivityMs,
    firstPrompt,
  };
}

// ---- scanning ---------------------------------------------------------------

/** Only transcripts touched within this window are candidates. */
export const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Take the most recent N files per project dir (mtime desc). */
export const BACKFILL_PER_DIR = 5;

/**
 * Scan ~/.claude/projects/<dir>/*.jsonl for recent candidates. Scan-only —
 * no process knowledge here; matching lives in backfillLiveClaudeSessions.
 */
export function scanRecentTranscripts(claudeHome: string): BackfillCandidate[] {
  const projectsDir = join(claudeHome, "projects");
  const cutoff = Date.now() - BACKFILL_WINDOW_MS;
  const out: BackfillCandidate[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return out; // no projects dir — nothing to scan
  }
  for (const dir of dirs) {
    const full = join(projectsDir, dir);
    let files: string[] = [];
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue; // unreadable dir — skip
    }
    const recent = files
      .map((f) => {
        const p = join(full, f);
        try {
          return { p, mtimeMs: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: string; mtimeMs: number } => x !== null && x.mtimeMs >= cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, BACKFILL_PER_DIR);
    for (const { p } of recent) {
      try {
        out.push(parseTranscriptCandidate(readFileSync(p, "utf8"), p));
      } catch {
        // unreadable file — skip
      }
    }
  }
  return out;
}
