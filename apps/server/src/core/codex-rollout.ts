import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Pure IO over Codex's own session records under ~/.codex:
 *   sessions/YYYY/MM/DD/rollout-*.jsonl — one per conversation; the first
 *   line is session_meta with the conversation uuid and cwd; a rollout is
 *   written when the FIRST user instruction arrives (which can be hours
 *   after the codex process launched), and `codex resume` APPENDS to the
 *   original file rather than creating a new one.
 *   session_index.jsonl — thread_name entries Codex maintains itself.
 *
 * This module only READS; every matching/derivation policy lives in
 * codex-titles.ts (titles, busy) and wake/codex.ts (wakes).
 */

export interface CodexRollout {
  path: string;
  codexSessionId: string | null;
  cwd: string | null;
  startedAtMs: number | null;
  mtimeMs: number;
}

// Synthetic user-role texts Codex injects into the rollout — none of them
// are the human's instruction.
export const SYNTHETIC_PROMPT_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "# AGENTS.md instructions",
  "Another language model started to solve", // resume/fork handoff blob
];

/** Case-insensitive on Windows only, matching how the OS treats paths. */
export function normalizeDir(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Read only the first line of a file. The session_meta line can be large
 * (it embeds base instructions), so grow in 64KB chunks up to 256KB.
 */
export function readFirstLine(path: string): string | null {
  const CHUNK = 64 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(CHUNK);
    let acc = Buffer.alloc(0);
    for (let i = 0; i < 4; i++) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      acc = Buffer.concat([acc, buf.subarray(0, n)]);
      const nl = acc.indexOf(10);
      if (nl !== -1) return acc.subarray(0, nl).toString("utf8");
      if (n < CHUNK) break;
    }
    return acc.length > 0 ? acc.toString("utf8") : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** sessions/ dir keys covering [fromMs, toMs] (rollout dirs use local dates). */
function dayKeysBetween(fromMs: number, toMs: number): string[] {
  const keys = new Set<string>();
  for (let t = fromMs; t <= toMs + 86_400_000; t += 86_400_000) {
    keys.add(localDayKey(new Date(t)));
  }
  return [...keys];
}

/**
 * Rollouts whose day-dir falls in the window (2 days of slack for clock
 * skew). Only the first line of each file is parsed, so this stays cheap
 * even with months of history on disk.
 */
export function listCodexRollouts(codexHome: string, sinceMs: number): CodexRollout[] {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return [];
  const rollouts: CodexRollout[] = [];
  for (const key of dayKeysBetween(sinceMs - 2 * 86_400_000, Date.now())) {
    const dir = join(root, key);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // day dir doesn't exist — normal for gaps
    }
    for (const f of files) {
      if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      const line = readFirstLine(path);
      if (!line) continue;
      try {
        const j = JSON.parse(line) as {
          type?: string;
          payload?: { id?: unknown; session_id?: unknown; cwd?: unknown; timestamp?: unknown };
        };
        if (j.type !== "session_meta" || !j.payload) continue;
        const id =
          typeof j.payload.id === "string"
            ? j.payload.id
            : typeof j.payload.session_id === "string"
              ? j.payload.session_id
              : null;
        const ts = typeof j.payload.timestamp === "string" ? Date.parse(j.payload.timestamp) : NaN;
        rollouts.push({
          path,
          codexSessionId: id,
          cwd: typeof j.payload.cwd === "string" ? j.payload.cwd : null,
          startedAtMs: Number.isFinite(ts) ? ts : null,
          mtimeMs: statSync(path).mtimeMs,
        });
      } catch {
        continue; // malformed meta line — skip the file
      }
    }
  }
  return rollouts;
}

/** All human-authored user prompts in a rollout, synthetic blobs filtered out. */
export function readCodexUserPrompts(rolloutPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(rolloutPath, "utf8");
  } catch {
    return [];
  }
  const prompts: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"role":"user"')) continue; // cheap prefilter
    try {
      const j = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: Array<{ type?: string; text?: unknown }>;
        };
      };
      if (j.type !== "response_item" || j.payload?.type !== "message" || j.payload.role !== "user") {
        continue;
      }
      for (const c of j.payload.content ?? []) {
        if (c.type !== "input_text" || typeof c.text !== "string") continue;
        const t = c.text.trim();
        if (!t || SYNTHETIC_PROMPT_PREFIXES.some((p) => t.startsWith(p))) continue;
        prompts.push(t);
      }
    } catch {
      continue; // malformed line — keep scanning
    }
  }
  return prompts;
}

/** Map of codex conversation uuid → latest thread_name (later entries win). */
export function readCodexThreadNames(codexHome: string): Map<string, string> {
  const names = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(join(codexHome, "session_index.jsonl"), "utf8");
  } catch {
    return names; // no index — callers fall back to prompt excerpts
  }
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const j = JSON.parse(l) as { id?: unknown; thread_name?: unknown };
      if (typeof j.id !== "string" || typeof j.thread_name !== "string") continue;
      const name = j.thread_name.replace(/\s+/g, " ").trim().slice(0, 64);
      if (name) names.set(j.id, name);
    } catch {
      continue;
    }
  }
  return names;
}

/**
 * Tail digest of a rollout's real conversation (user asks + assistant
 * answers), for injecting context into a wake run that cannot resume the
 * locked thread. Returns "" when the file is unreadable.
 */
export function codexRolloutDigest(rolloutPath: string, maxChars = 1500): string {
  let text: string;
  try {
    text = readFileSync(rolloutPath, "utf8");
  } catch {
    return "";
  }
  const turns: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"response_item"')) continue;
    try {
      const j = JSON.parse(line) as {
        payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: unknown }> };
      };
      const p = j.payload;
      if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
      const parts = (p.content ?? [])
        .filter((c) => (c.type === "input_text" || c.type === "output_text") && typeof c.text === "string")
        .map((c) => c.text as string);
      if (parts.length === 0) continue;
      const t = parts.join(" ").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (p.role === "user" && SYNTHETIC_PROMPT_PREFIXES.some((x) => t.startsWith(x))) continue;
      turns.push(`${p.role === "user" ? "用户" : "助手"}: ${t.slice(0, 300)}`);
    } catch {
      continue;
    }
  }
  const digest = turns.slice(-12).join("\n");
  return digest.length > maxChars ? digest.slice(digest.length - maxChars) : digest;
}

/** Locate the rollout jsonl for a codex conversation uuid (filename suffix). */
export function findCodexRolloutPath(codexSessionId: string): string {
  try {
    const root = join(
      (process.env.USERPROFILE || process.env.HOME || ".") + "/.codex/sessions"
    );
    // day dirs from 30d back to today; the filename embeds the uuid
    for (let t = Date.now() - 30 * 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
      const d = new Date(t);
      const p2 = (n: number) => String(n).padStart(2, "0");
      const dir = join(root, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const hit = files.find((f) => f.endsWith(codexSessionId + ".jsonl"));
      if (hit) return join(dir, hit);
    }
  } catch {
    // fall through
  }
  return "";
}
