import type { ContextEntry, ContextKind } from "@conflux/shared";
import { nowIso, type DB } from "./db.js";
import { publishLiveEvent } from "./event-bus.js";

const VALID_KINDS = new Set<ContextKind>(["note", "decision", "artifact", "summary", "handoff"]);
const INCREMENTAL_MEMORY_CHAR_BUDGET = 4000;

interface ContextRow {
  id: number;
  thread_id: string;
  project_id: number | null;
  room_id: number | null;
  kind: string;
  pinned: number;
  title: string;
  content: string;
  tags: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function toEntry(row: ContextRow): ContextEntry {
  let tags: string[] | null = null;
  if (row.tags) {
    try {
      const parsed = JSON.parse(row.tags);
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = null;
    }
  }
  return {
    id: row.id,
    thread_id: row.thread_id,
    project_id: row.project_id,
    room_id: row.room_id,
    kind: (VALID_KINDS.has(row.kind as ContextKind) ? row.kind : "note") as ContextKind,
    pinned: row.pinned === 1,
    title: row.title,
    content: row.content,
    tags,
    version: row.version ?? 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getContext(db: DB, id: number): ContextEntry | null {
  const row = db.prepare(`SELECT * FROM context_entries WHERE id = ?`).get(id) as
    | ContextRow
    | undefined;
  return row ? toEntry(row) : null;
}

/**
 * Append a new structured shared-memory entry inside an IMMEDIATE transaction
 * so concurrent writers never interleave or clobber one another.
 */
export function publishContext(
  db: DB,
  input: {
    thread_id: string;
    project_id?: number | null;
    room_id?: number | null;
    kind?: ContextKind;
    pinned?: boolean;
    title: string;
    content: string;
    tags?: string[] | null;
  },
): ContextEntry {
  const title = input.title?.trim();
  const content = input.content?.trim();
  if (!title || !content) {
    throw Object.assign(new Error("title and content are required"), { statusCode: 400 });
  }
  const kind: ContextKind =
    input.kind && VALID_KINDS.has(input.kind) ? input.kind : "note";
  const pinned = input.pinned ? 1 : 0;
  const tagsJson = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;

  const entry = db
    .transaction(() => {
      const now = nowIso();
      const res = db
        .prepare(
          `INSERT INTO context_entries
           (thread_id, project_id, room_id, kind, pinned, title, content, tags, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.thread_id,
          input.project_id ?? null,
          input.room_id ?? null,
          kind,
          pinned,
          title,
          content,
          tagsJson,
          now,
          now,
        );
      return getContext(db, Number(res.lastInsertRowid))!;
    })
    .immediate();

  publishLiveEvent({
    type: "context.updated",
    project_id: entry.project_id,
    thread_id: entry.thread_id,
    room_id: entry.room_id,
    payload: { action: "created", entry },
  });
  return entry;
}

/**
 * Update an entry with optimistic concurrency control (`expected_version`) inside
 * an IMMEDIATE transaction so concurrent agent writes never silently overwrite each other.
 */
export function updateContext(
  db: DB,
  id: number,
  patch: {
    title?: string;
    content?: string;
    tags?: string[] | null;
    project_id?: number | null;
    room_id?: number | null;
    kind?: ContextKind;
    pinned?: boolean;
    expected_version?: number;
  },
): ContextEntry | null {
  const updated = db
    .transaction(() => {
      const existing = getContext(db, id);
      if (!existing) return null;
      if (
        patch.expected_version !== undefined &&
        patch.expected_version !== existing.version
      ) {
        throw Object.assign(
          new Error(
            `共享记忆版本冲突（期望 v${patch.expected_version}，当前 v${existing.version}），请刷新后重试或追加新条目`,
          ),
          { statusCode: 409 },
        );
      }
      const nextTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
      const nextContent = patch.content !== undefined ? patch.content.trim() : existing.content;
      const nextTags =
        patch.tags !== undefined
          ? patch.tags && patch.tags.length > 0
            ? JSON.stringify(patch.tags)
            : null
          : existing.tags
            ? JSON.stringify(existing.tags)
            : null;
      const nextProjectId = patch.project_id !== undefined ? patch.project_id : existing.project_id;
      const nextRoomId = patch.room_id !== undefined ? patch.room_id : existing.room_id;
      const nextKind =
        patch.kind && VALID_KINDS.has(patch.kind) ? patch.kind : existing.kind;
      const nextPinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned ? 1 : 0;
      const nextVersion = existing.version + 1;

      const res = db
        .prepare(
          `UPDATE context_entries
           SET title = ?, content = ?, tags = ?, project_id = ?, room_id = ?,
               kind = ?, pinned = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          nextTitle,
          nextContent,
          nextTags,
          nextProjectId,
          nextRoomId,
          nextKind,
          nextPinned,
          nextVersion,
          nowIso(),
          id,
          existing.version,
        );
      if (!res.changes) {
        throw Object.assign(new Error("共享记忆并发修改冲突，请重试"), { statusCode: 409 });
      }
      return getContext(db, id);
    })
    .immediate();

  if (updated) {
    publishLiveEvent({
      type: "context.updated",
      project_id: updated.project_id,
      thread_id: updated.thread_id,
      room_id: updated.room_id,
      payload: { action: "updated", entry: updated },
    });
  }
  return updated;
}

export function deleteContext(db: DB, id: number): boolean {
  const existing = getContext(db, id);
  if (!existing) return false;
  const ok = db.prepare(`DELETE FROM context_entries WHERE id = ?`).run(id).changes > 0;
  if (ok) {
    publishLiveEvent({
      type: "context.updated",
      project_id: existing.project_id,
      thread_id: existing.thread_id,
      room_id: existing.room_id,
      payload: { action: "deleted", id },
    });
  }
  return ok;
}

export function listProjectContext(db: DB, projectId: number, limit = 100): ContextEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM context_entries
       WHERE project_id = ?
       ORDER BY pinned DESC, id DESC
       LIMIT ?`,
    )
    .all(projectId, Math.max(1, Math.min(limit, 500))) as ContextRow[];
  return rows.map(toEntry);
}

export function listRoomContext(db: DB, roomId: number, limit = 100): ContextEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM context_entries
       WHERE room_id = ?
       ORDER BY pinned DESC, id DESC
       LIMIT ?`,
    )
    .all(roomId, Math.max(1, Math.min(limit, 500))) as ContextRow[];
  return rows.map(toEntry);
}

export function queryContext(
  db: DB,
  opts: {
    query?: string;
    thread_id?: string;
    project_id?: number;
    room_id?: number;
    kind?: ContextKind;
    pinned?: boolean;
    limit?: number;
  } = {},
): ContextEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.thread_id) {
    clauses.push("thread_id = ?");
    params.push(opts.thread_id);
  }
  if (opts.project_id !== undefined) {
    clauses.push("project_id = ?");
    params.push(opts.project_id);
  }
  if (opts.room_id !== undefined) {
    clauses.push("room_id = ?");
    params.push(opts.room_id);
  }
  if (opts.kind) {
    clauses.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.pinned !== undefined) {
    clauses.push("pinned = ?");
    params.push(opts.pinned ? 1 : 0);
  }
  if (opts.query?.trim()) {
    const like = `%${opts.query.trim()}%`;
    clauses.push("(title LIKE ? OR content LIKE ? OR COALESCE(tags, '') LIKE ?)");
    params.push(like, like, like);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const rows = db
    .prepare(`SELECT * FROM context_entries ${where} ORDER BY pinned DESC, id DESC LIMIT ?`)
    .all(...params, limit) as ContextRow[];
  return rows.map(toEntry);
}

/**
 * Prompt-Cache-friendly incremental pinned memory suffix.
 *
 * Instead of mutating the static system prompt (which busts LLM KV prompt caches),
 * each thread tracks `last_synced_context_id`. Before sending a new user turn,
 * only pinned entries strictly newer than that cursor for the thread's project/room
 * are appended to the END of the user prompt, keeping every prior prefix byte-identical.
 */
export function collectIncrementalPinnedMemory(
  db: DB,
  input: {
    projectId: number | null;
    roomId: number | null;
    afterId: number;
    maxChars?: number;
  },
): { suffix: string; maxId: number; count: number } {
  const scopeClauses: string[] = [];
  const params: unknown[] = [input.afterId];
  if (input.projectId !== null) {
    scopeClauses.push("project_id = ?");
    params.push(input.projectId);
  }
  if (input.roomId !== null) {
    scopeClauses.push("room_id = ?");
    params.push(input.roomId);
  }
  if (scopeClauses.length === 0) {
    return { suffix: "", maxId: input.afterId, count: 0 };
  }

  const rows = db
    .prepare(
      `SELECT * FROM context_entries
       WHERE pinned = 1 AND id > ? AND (${scopeClauses.join(" OR ")})
       ORDER BY id ASC
       LIMIT 30`,
    )
    .all(...params) as ContextRow[];

  if (rows.length === 0) {
    return { suffix: "", maxId: input.afterId, count: 0 };
  }

  const budget = input.maxChars ?? INCREMENTAL_MEMORY_CHAR_BUDGET;
  const lines: string[] = ["\n\n---\n[新增项目/房间置顶共享记忆（增量追加）]"];
  let used = lines[0].length;
  let maxId = input.afterId;
  let included = 0;

  for (const row of rows) {
    const entry = toEntry(row);
    const block = `- [#${entry.id} ${entry.kind}] ${entry.title}: ${entry.content}`;
    const trimmed =
      used + block.length + 1 > budget
        ? `${block.slice(0, Math.max(80, budget - used - 20))}…`
        : block;
    lines.push(trimmed);
    used += trimmed.length + 1;
    maxId = Math.max(maxId, entry.id);
    included++;
    if (used >= budget) break;
  }

  return {
    suffix: lines.join("\n"),
    maxId,
    count: included,
  };
}
