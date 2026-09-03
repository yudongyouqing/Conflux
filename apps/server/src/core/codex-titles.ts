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
import type { DB } from "./db.js";
import { logger } from "../log.js";
import { promptExcerpt } from "./live.js";
import { mergeSessionMeta, renameSession, setSessionDescription } from "./sessions.js";

/**
 * Rollout-derived titles for Codex sessions.
 *
 * Codex has no hook system, so — unlike Claude Code — nothing tells us what
 * a conversation is about while it runs. But Codex writes its own session
 * records under ~/.codex: one rollout-*.jsonl per conversation (first line
 * is session_meta with the conversation uuid and cwd) plus session_index.jsonl
 * (thread_name entries Codex maintains itself, refreshed as the conversation
 * progresses). A rollout is written when the FIRST user instruction arrives,
 * which can be hours after the codex process launched.
 *
 * Correlating a muiltchat row to a rollout cannot rely on cwd alone: when
 * the MCP server is configured globally with a fixed working directory
 * (e.g. `npm --prefix <repo> run mcp`), every codex session records that
 * directory as project_dir no matter where Codex actually runs, while the
 * rollout records the REAL directory. Matching therefore works in tiers:
 *   1. the codex_session_id we stamped on a previous pass — absolute: a
 *      stamped row never rebinds, and if its rollout is gone the row is
 *      skipped (falling through would let it steal a sibling's rollout);
 *   2. unstamped rows and unclaimed rollouts are matched greedily by
 *      tightest |rollout.start − row.created| (cwd-exact pairs rank first).
 *      Prompt latency is unbounded, so gap SIZE only ranks candidates —
 *      a row opened this morning can still claim a rollout written tonight.
 *   3. resumed conversations: `codex resume` appends to the ORIGINAL
 *      rollout, so its start predates the row. A rollout that started
 *      before the row existed AND was modified in the last half hour is
 *      the live continuation — claim it (cwd-exact ranks first).
 * Each rollout belongs to at most one row; rollouts stamped on other rows
 * are never candidates. Sibling sessions launched within seconds of each
 * other can still cross-assign — the titles remain real titles of real
 * sibling conversations, which beats three rows all named "server".
 *
 * Title priority: a name set via register_session (or any external rename)
 * is never overridden; otherwise Codex's thread_name; otherwise an excerpt
 * of the first real user instruction (synthetic blobs like
 * <environment_context> are skipped).
 */

const AUTO_REGISTERED_DESCRIPTION = "Codex session (auto-registered)";

// A rollout may start slightly BEFORE its MCP row exists (Codex writes the
// meta line, then spawns MCP children) — allow this much skew.
const ROLLOUT_SKEW_MS = 120_000;

// `codex resume` appends new turns to the ORIGINAL rollout file, which can
// predate the session row by days. Scan day-dirs back this far so resumed
// threads stay visible, and treat an old-start rollout as the live
// continuation only while its mtime is this fresh (the old thread is being
// written to right now — a stale mtime means it is just history).
const RESUME_LOOKBACK_MS = 30 * 86_400_000;
const RESUME_ACTIVE_MS = 30 * 60_000;

// Busy signal: an actively generating conversation appends to its rollout
// every few seconds. Sampled on the 30s tick, so allow a generous window —
// long tool runs can go a minute without emitting anything.
const CODEX_BUSY_FRESH_MS = 90_000;

// Synthetic user-role texts Codex injects into the rollout — none of them
// are the human's instruction, so none may become a title.
const SYNTHETIC_PROMPT_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "# AGENTS.md instructions",
  "Another language model started to solve", // resume/fork handoff blob
];

export interface CodexRollout {
  path: string;
  codexSessionId: string | null;
  cwd: string | null;
  startedAtMs: number | null;
  mtimeMs: number;
}

interface SessionRow {
  id: string;
  name: string;
  description: string | null;
  project_dir: string | null;
  created_at: string;
  metadata: string | null;
}

export interface MatchRow {
  id: string;
  projectDir: string;
  createdMs: number;
}

function parseMeta(row: { metadata: string | null }): Record<string, unknown> {
  if (!row.metadata) return {};
  try {
    return JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Case-insensitive on Windows only, matching how the OS treats paths. */
function normalizeDir(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Read only the first line of a file. The session_meta line can be large
 * (it embeds base instructions), so grow in 64KB chunks up to 256KB.
 */
function readFirstLine(path: string): string | null {
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
    return names; // no index — fall back to prompt excerpts
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
  const BS = String.fromCharCode(92); // backslash, shell-transport-safe
  let text: string;
  try {
    text = readFileSync(rolloutPath, "utf8");
  } catch {
    return "";
  }
  const turns: string[] = [];
  const NL = String.fromCharCode(10); // shell-transport-safe newline
  for (const line of text.split(NL)) {
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
      const t = parts.join(" ").replace(new RegExp(BS + "s+", "g"), " ").trim();
      if (!t) continue;
      if (p.role === "user" && SYNTHETIC_PROMPT_PREFIXES.some((x) => t.startsWith(x))) continue;
      turns.push(`${p.role === "user" ? "用户" : "助手"}: ${t.slice(0, 300)}`);
    } catch {
      continue;
    }
  }
  const digest = turns.slice(-12).join(NL);
  return digest.length > maxChars ? digest.slice(digest.length - maxChars) : digest;
}

/**
 * Greedy bipartite match of unstamped session rows to unclaimed rollouts by
 * tightest |rollout.start − row.created|, cwd-exact pairs ranking first.
 * Ties resolve to the older row so the pass is deterministic. A rollout is
 * only eligible for rows that already existed when it started (minus skew).
 */
export function matchCodexRollouts(
  rows: MatchRow[],
  rollouts: CodexRollout[],
  ownedSessionIds: Set<string>
): Map<string, CodexRollout> {
  const matches = new Map<string, CodexRollout>();
  const cands = rollouts.filter(
    (r) => r.codexSessionId !== null && r.startedAtMs !== null && !ownedSessionIds.has(r.codexSessionId!)
  );
  if (rows.length === 0 || cands.length === 0) return matches;

  interface Pair {
    row: MatchRow;
    rollout: CodexRollout;
    cwdMatch: boolean;
    gap: number;
  }
  const pairs: Pair[] = [];
  for (const row of rows) {
    for (const r of cands) {
      if (r.startedAtMs! < row.createdMs - ROLLOUT_SKEW_MS) continue; // row didn't exist yet
      const cwdMatch = r.cwd !== null && normalizeDir(r.cwd) === normalizeDir(row.projectDir);
      pairs.push({ row, rollout: r, cwdMatch, gap: Math.abs(r.startedAtMs! - row.createdMs) });
    }
  }
  pairs.sort(
    (a, b) =>
      Number(b.cwdMatch) - Number(a.cwdMatch) || // cwd agreement is decisive
      a.gap - b.gap || // then tightest launch-to-prompt gap
      a.row.createdMs - b.row.createdMs // deterministic tie-break
  );
  const takenRollouts = new Set<string>();
  for (const p of pairs) {
    if (matches.has(p.row.id) || takenRollouts.has(p.rollout.path)) continue;
    matches.set(p.row.id, p.rollout);
    takenRollouts.add(p.rollout.path);
  }
  return matches;
}

export interface CodexTitleRefreshOptions {
  codexHome?: string;
  /** Refresh a single session row (used from the MCP heartbeat). */
  onlySessionId?: string;
}

/**
 * Retitle active Codex sessions from their rollouts. A row is managed only
 * while it is an untouched auto-registered placeholder or still carries the
 * exact name we applied last time — any other name means register_session
 * (or a user rename) claimed it, and we never touch it again.
 * Returns how many rows were updated.
 */
export function refreshCodexSessionTitles(db: DB, opts: CodexTitleRefreshOptions = {}): number {
  const home = opts.codexHome ?? join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");
  const rows = (
    opts.onlySessionId
      ? db
          .prepare(
            `SELECT id, name, description, project_dir, created_at, metadata FROM sessions WHERE id = ?`
          )
          .all(opts.onlySessionId)
      : db
          .prepare(
            `SELECT id, name, description, project_dir, created_at, metadata FROM sessions
             WHERE status = 'active' AND metadata LIKE '%"runtime":"codex"%'`
          )
          .all()
  ) as SessionRow[];

  const eligible = rows.filter((row) => {
    const meta = parseMeta(row);
    if (meta.agent_id !== undefined) return false; // preset rows are named by their preset
    if (row.description === AUTO_REGISTERED_DESCRIPTION) return true;
    return typeof meta.codex_name === "string" && row.name === meta.codex_name;
  });
  if (eligible.length === 0) return 0;

  // Rollouts already owned by a stamped row (any status) are off-limits to
  // unstamped rows, across passes.
  const ownedSessionIds = new Set<string>();
  for (const { metadata } of db
    .prepare(`SELECT metadata FROM sessions WHERE metadata LIKE '%"codex_session_id"%'`)
    .all() as { metadata: string | null }[]) {
    const id = parseMeta({ metadata }).codex_session_id;
    if (typeof id === "string") ownedSessionIds.add(id);
  }

  const createdStamps = eligible
    .map((r) => Date.parse(r.created_at))
    .filter((t) => Number.isFinite(t));
  const scanSince = Math.min(
    createdStamps.length > 0 ? Math.min(...createdStamps) : Date.now(),
    Date.now() - RESUME_LOOKBACK_MS
  );
  const rollouts = listCodexRollouts(home, scanSince);
  if (rollouts.length === 0) return 0;
  const threadNames = readCodexThreadNames(home);

  // Stamped rows bind absolutely; unstamped rows go through the matcher.
  const stamped = new Map<string, CodexRollout>();
  const matchRows: MatchRow[] = [];
  for (const row of eligible) {
    if (!row.project_dir) continue;
    const meta = parseMeta(row);
    const stamp = typeof meta.codex_session_id === "string" ? meta.codex_session_id : null;
    if (stamp) {
      // Previously bound: the stamp is absolute. Rollout gone (archived,
      // pruned) → skip — re-guessing would steal a sibling's rollout.
      const own = rollouts.find((r) => r.codexSessionId === stamp);
      if (own) stamped.set(row.id, own);
      continue;
    }
    const createdMs = Date.parse(row.created_at);
    if (Number.isFinite(createdMs)) {
      matchRows.push({ id: row.id, projectDir: row.project_dir, createdMs });
    }
  }
  const matches = matchCodexRollouts(matchRows, rollouts, ownedSessionIds);

  // Phase 2 — resumed conversations (see tier 3 in the module docblock):
  // rows left unmatched pair with old-start rollouts whose mtime says the
  // thread is being written to right now. Rows go oldest-first so the pass
  // is deterministic.
  const claimedPaths = new Set([...matches.values()].map((r) => r.path));
  const nowMs = Date.now();
  const activeResumes = rollouts.filter(
    (r) =>
      r.codexSessionId !== null &&
      r.startedAtMs !== null &&
      r.mtimeMs >= nowMs - RESUME_ACTIVE_MS &&
      !ownedSessionIds.has(r.codexSessionId!) &&
      !claimedPaths.has(r.path)
  );
  const unmatched = matchRows
    .filter((r) => !matches.has(r.id))
    .sort((a, b) => a.createdMs - b.createdMs);
  for (const row of unmatched) {
    const cands = activeResumes.filter(
      (r) => !claimedPaths.has(r.path) && r.startedAtMs! < row.createdMs - ROLLOUT_SKEW_MS
    );
    if (cands.length === 0) continue;
    cands.sort((a, b) => {
      const am = a.cwd !== null && normalizeDir(a.cwd) === normalizeDir(row.projectDir);
      const bm = b.cwd !== null && normalizeDir(b.cwd) === normalizeDir(row.projectDir);
      return Number(bm) - Number(am) || b.mtimeMs - a.mtimeMs;
    });
    matches.set(row.id, cands[0]);
    claimedPaths.add(cands[0].path);
  }

  let updated = 0;
  for (const row of eligible) {
    try {
      const rollout = stamped.get(row.id) ?? matches.get(row.id);
      if (!rollout || !rollout.codexSessionId) continue;
      const prompts = readCodexUserPrompts(rollout.path);
      if (prompts.length === 0) continue; // conversation not started yet

      const thread = threadNames.get(rollout.codexSessionId) ?? null;
      const title = thread ?? promptExcerpt(prompts[0]);
      if (!title) continue;
      const lastExcerpt = promptExcerpt(prompts[prompts.length - 1]) ?? title;

      ownedSessionIds.add(rollout.codexSessionId);
      if (title !== row.name) renameSession(db, row.id, title);
      if (lastExcerpt !== row.description) setSessionDescription(db, row.id, lastExcerpt);
      // Rewrite metadata wholesale to drop `temp` (a titled session is an
      // adopted identity, not a placeholder that hides when stale).
      const meta = parseMeta(row);
      const { temp: _drop, ...rest } = meta;
      db.prepare(`UPDATE sessions SET metadata = ? WHERE id = ?`).run(
        JSON.stringify({
          ...rest,
          named: true,
          codex_session_id: rollout.codexSessionId,
          codex_name: title,
          codex_title: thread ? "thread" : "prompt",
        }),
        row.id
      );
      updated++;
    } catch {
      continue; // one bad row must not block the rest
    }
  }
  // Busy flag for ALL active codex rows (not just title-managed ones):
  // rollout written to recently = a turn is in progress. Write only on
  // change — a merge every 30s would be pointless WAL churn.
  const nowBusy = Date.now();
  // re-read metadata: the title loop above may have just stamped it
  const readMeta = db.prepare(`SELECT metadata FROM sessions WHERE id = ?`);
  for (const row of rows) {
    try {
      const fresh = readMeta.get(row.id) as { metadata: string | null } | undefined;
      if (!fresh) continue;
      const meta = parseMeta(fresh);
      const stamp = typeof meta.codex_session_id === "string" ? meta.codex_session_id : null;
      if (!stamp) continue;
      const r = rollouts.find((x) => x.codexSessionId === stamp);
      if (!r) continue;
      const busy = nowBusy - r.mtimeMs < CODEX_BUSY_FRESH_MS;
      if (meta.busy === busy) continue;
      mergeSessionMeta(db, row.id, { busy });
    } catch {
      continue;
    }
  }

  if (updated > 0) logger.info({ updated }, "codex session titles refreshed");
  return updated;
}
