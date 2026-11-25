import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Project, ProjectFileMatch } from "@conflux/shared";
import { nowIso, type DB } from "./db.js";
import { getDefaultBranch, isGitRepo, normalizePathKey } from "./git-worktree.js";
import { publishLiveEvent } from "./event-bus.js";

interface ProjectRow {
  id: number;
  name: string;
  root_path: string;
  default_branch: string | null;
  is_git_repo: number;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    root_path: row.root_path,
    default_branch: row.default_branch,
    is_git_repo: row.is_git_repo === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listProjects(db: DB): Project[] {
  const rows = db
    .prepare(`SELECT * FROM projects ORDER BY updated_at DESC, id DESC`)
    .all() as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(db: DB, id: number): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

export function findProjectByPath(db: DB, rootPath: string): Project | null {
  const target = normalizePathKey(rootPath);
  for (const proj of listProjects(db)) {
    if (normalizePathKey(proj.root_path) === target) return proj;
  }
  return null;
}

export function createProject(
  db: DB,
  input: { root_path: string; name?: string },
): Project {
  const trimmed = input.root_path?.trim();
  if (!trimmed) {
    throw Object.assign(new Error("root_path is required"), { statusCode: 400 });
  }
  const absPath = resolve(trimmed);
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    throw Object.assign(new Error(`项目目录不存在或不是文件夹：${absPath}`), { statusCode: 400 });
  }

  const existing = findProjectByPath(db, absPath);
  if (existing) {
    const isGit = isGitRepo(absPath);
    const defaultBranch = isGit ? getDefaultBranch(absPath) : null;
    const nextName = input.name?.trim() || existing.name;
    db.prepare(
      `UPDATE projects SET name = ?, default_branch = ?, is_git_repo = ?, updated_at = ? WHERE id = ?`,
    ).run(nextName, defaultBranch, isGit ? 1 : 0, nowIso(), existing.id);
    return getProject(db, existing.id)!;
  }

  const isGit = isGitRepo(absPath);
  const defaultBranch = isGit ? getDefaultBranch(absPath) : null;
  const name = input.name?.trim() || basename(absPath) || absPath;
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO projects (name, root_path, default_branch, is_git_repo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, absPath, defaultBranch, isGit ? 1 : 0, now, now);
  const project = getProject(db, Number(res.lastInsertRowid))!;
  publishLiveEvent({
    type: "project.updated",
    project_id: project.id,
    payload: { action: "created", project },
  });
  return project;
}

/**
 * Find or automatically create a Project for an external MCP session's project_dir.
 * Returns null when the directory does not exist on disk.
 */
export function ensureProjectForDir(db: DB, dir: string | null | undefined): Project | null {
  if (!dir?.trim()) return null;
  const abs = resolve(dir.trim());
  const existing = findProjectByPath(db, abs);
  if (existing) return existing;
  // Also match when the dir is inside an existing project root (e.g. a worktree or subdir).
  const norm = normalizePathKey(abs);
  for (const proj of listProjects(db)) {
    const rootKey = normalizePathKey(proj.root_path);
    if (norm === rootKey || norm.startsWith(`${rootKey}/`) || norm.startsWith(`${rootKey}\\`)) {
      return proj;
    }
  }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return null;
  return createProject(db, { root_path: abs });
}

export function deleteProject(db: DB, id: number): boolean {
  const res = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  if (res.changes > 0) {
    publishLiveEvent({
      type: "project.updated",
      project_id: id,
      payload: { action: "deleted", project_id: id },
    });
    return true;
  }
  return false;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".conflux-worktrees",
  ".worktrees",
  "coverage",
  "__pycache__",
  ".venv",
  "target",
]);

/** Fast bounded file walker for `@` project file autocomplete. */
export function searchProjectFiles(
  rootDir: string,
  query = "",
  limit = 30,
  maxScanned = 3000,
): ProjectFileMatch[] {
  if (!existsSync(rootDir)) return [];
  const q = query.trim().toLowerCase();
  const absRoot = resolve(rootDir);
  const scored: Array<{ match: ProjectFileMatch; score: number }> = [];
  let scanned = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 8 || scanned >= maxScanned) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (scanned >= maxScanned) break;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) {
          walk(join(dir, ent.name), depth + 1);
        }
        continue;
      }
      if (!ent.isFile()) continue;
      scanned++;
      const rel = relative(absRoot, join(dir, ent.name)).replace(/\\/g, "/");
      const lowerRel = rel.toLowerCase();
      const lowerName = ent.name.toLowerCase();
      if (!q) {
        scored.push({ match: { path: rel, name: ent.name }, score: 100 - depth });
        continue;
      }
      if (lowerName === q) {
        scored.push({ match: { path: rel, name: ent.name }, score: 1000 });
      } else if (lowerName.startsWith(q)) {
        scored.push({ match: { path: rel, name: ent.name }, score: 800 - rel.length });
      } else if (lowerRel.includes(q)) {
        scored.push({ match: { path: rel, name: ent.name }, score: 500 - rel.length });
      }
    }
  };

  walk(absRoot, 0);
  scored.sort((a, b) => b.score - a.score || a.match.path.localeCompare(b.match.path));
  return scored.slice(0, Math.max(1, Math.min(limit, 100))).map((s) => s.match);
}
