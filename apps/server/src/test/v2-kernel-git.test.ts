import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeDb } from "./helpers.js";
import { resolveConfig } from "../config.js";
import { SCHEMA_VERSION } from "../core/db.js";
import {
  createProject,
  deleteProject,
  ensureProjectForDir,
  listProjects,
  searchProjectFiles,
} from "../core/projects.js";
import {
  cleanupWorktree,
  createInvisibleCheckpoint,
  createWorktree,
  createWorktreePr,
  deleteThreadCheckpoints,
  getGitDiff,
  getGitStatus,
  mergeWorktreeBack,
  resolveGitBinary,
  rollbackToCheckpoint,
} from "../core/git-worktree.js";
import { createTemplate, deleteTemplate, listTemplates } from "../core/templates.js";
import { probeLocalClis } from "../core/cli-probe.js";
import { resolveLaunchPlan } from "../core/managed-codex/process.js";

function git(cwd: string, args: string[]): string {
  return execFileSync(resolveGitBinary(), args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeTempGitRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "conflux-v2-git-"));
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Conflux Test"]);
  git(repoDir, ["config", "user.email", "test@conflux.local"]);
  git(repoDir, ["config", "core.autocrlf", "false"]);
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# Demo Repo\ninitial line\n", "utf8");
  writeFileSync(join(repoDir, "src", "app.ts"), "export const answer = 42;\n", "utf8");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "initial commit"]);
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }),
  };
}

test("v2 config isolates conflux-v2.db from legacy data.db and initializes schema v20", () => {
  const dir = mkdtempSync(join(tmpdir(), "conflux-v2-cfg-"));
  try {
    const legacyFile = join(dir, "data.db");
    writeFileSync(legacyFile, "legacy-v1-sentinel", "utf8");
    const cfg = resolveConfig("global", dir);
    assert.equal(cfg.dbPath, join(dir, "conflux-v2.db"));
    assert.equal(readFileSync(legacyFile, "utf8"), "legacy-v1-sentinel");

    const { db, cleanup } = makeDb();
    try {
      assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
      ).map((t) => t.name);
      for (const required of [
        "projects",
        "agent_threads",
        "agent_templates",
        "thread_runs",
        "thread_events",
        "thread_approvals",
        "thread_checkpoints",
        "rooms",
        "room_members",
        "room_tasks",
        "messages",
        "edges",
        "context_entries",
        "workflows",
        "workflow_runs",
        "workflow_steps",
      ]) {
        assert.ok(tables.includes(required), `missing v2 table ${required}`);
      }
      assert.ok(!tables.includes("runtime_agents"), "legacy runtime_agents table must not exist in v2");
      assert.ok(!tables.includes("conversations"), "legacy conversations table must not exist in v2");
    } finally {
      cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects CRUD, auto-registration from dir, and @ file search", () => {
  const { db, cleanup } = makeDb();
  const { repoDir, cleanup: cleanupRepo } = makeTempGitRepo();
  try {
    mkdirSync(join(repoDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "pkg", "ignored.js"), "// skip\n", "utf8");
    writeFileSync(join(repoDir, "src", "workbench.tsx"), "export function Workbench() {}\n", "utf8");

    const proj = createProject(db, { root_path: repoDir, name: "DemoProj" });
    assert.equal(proj.name, "DemoProj");
    assert.equal(proj.is_git_repo, true);
    assert.equal(proj.default_branch, "main");
    assert.equal(listProjects(db).length, 1);

    const autoFound = ensureProjectForDir(db, join(repoDir, "src"));
    assert.equal(autoFound?.id, proj.id);

    const matches = searchProjectFiles(repoDir, "work");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].path, "src/workbench.tsx");
    const ignored = searchProjectFiles(repoDir, "ignored");
    assert.equal(ignored.length, 0, "node_modules must be skipped");

    const tpl = createTemplate(db, {
      name: "Backend Claude",
      runtime: "claude",
      model: "claude-sonnet-4-6",
      approval_mode: "auto",
      use_worktree: true,
    });
    assert.equal(listTemplates(db).length, 1);
    assert.equal(tpl.approval_mode, "auto");
    assert.equal(tpl.use_worktree, true);
    assert.equal(deleteTemplate(db, tpl.id), true);

    assert.equal(deleteProject(db, proj.id), true);
  } finally {
    cleanup();
    cleanupRepo();
  }
});

test("invisible Git checkpoints snapshot & rollback tracked + untracked changes with zero git log/stash pollution", () => {
  const { repoDir, cleanup } = makeTempGitRepo();
  try {
    const initialCommits = git(repoDir, ["rev-list", "--count", "HEAD"]);
    assert.equal(initialCommits, "1");
    assert.equal(git(repoDir, ["stash", "list"]), "");

    // Create dirty pre-turn state (tracked edit + pre-existing untracked file).
    writeFileSync(join(repoDir, "src", "app.ts"), "export const answer = 43;\n", "utf8");
    writeFileSync(join(repoDir, "pre-existing.txt"), "keep-me\n", "utf8");

    const snap = createInvisibleCheckpoint(repoDir, "thread-cp-1", 1);
    assert.ok(snap, "checkpoint snapshot must be created");
    assert.match(snap.refName, /^refs\/conflux\/checkpoints\/thread-cp-1\/1$/);

    // Git history & stash remain 100% untouched.
    assert.equal(git(repoDir, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(repoDir, ["stash", "list"]), "");

    // Simulate agent making bad edits and adding a new untracked file.
    writeFileSync(join(repoDir, "src", "app.ts"), "BROKEN CODE\n", "utf8");
    writeFileSync(join(repoDir, "bad-new-file.ts"), "should be deleted\n", "utf8");

    rollbackToCheckpoint(repoDir, snap.refName);

    assert.equal(readFileSync(join(repoDir, "src", "app.ts"), "utf8"), "export const answer = 43;\n");
    assert.equal(readFileSync(join(repoDir, "pre-existing.txt"), "utf8"), "keep-me\n");
    assert.equal(existsSync(join(repoDir, "bad-new-file.ts")), false);
    assert.equal(git(repoDir, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(repoDir, ["stash", "list"]), "");

    const deletedRefs = deleteThreadCheckpoints(repoDir, "thread-cp-1");
    assert.equal(deletedRefs, 1);
  } finally {
    cleanup();
  }
});

test("Git worktree create, live diff, merge-back, conflict auto-abort, and cleanup", () => {
  const { repoDir, cleanup } = makeTempGitRepo();
  try {
    // 1. Happy path: create worktree, edit tracked + untracked files, inspect status/diff, merge back.
    const wt1 = createWorktree(repoDir, "feature-alpha");
    assert.ok(existsSync(wt1.worktreePath));
    assert.match(wt1.branch, /^conflux\/feature-alpha-/);
    // `.gitignore` is untouched; `.git/info/exclude` gets `.conflux-worktrees/`.
    assert.equal(existsSync(join(repoDir, ".gitignore")), false);
    const excludeText = readFileSync(join(repoDir, ".git", "info", "exclude"), "utf8");
    assert.ok(excludeText.includes(".conflux-worktrees/"));

    writeFileSync(join(wt1.worktreePath, "src", "app.ts"), "export const answer = 99;\n", "utf8");
    writeFileSync(join(wt1.worktreePath, "notes.md"), "new note\n", "utf8");

    const status = getGitStatus(wt1.worktreePath, wt1.baseBranch);
    assert.equal(status.dirty, true);
    assert.ok(status.files.some((f) => f.path === "src/app.ts" && f.status === "modified"));
    assert.ok(status.files.some((f) => f.path === "notes.md" && f.status === "untracked"));

    const diffAll = getGitDiff(wt1.worktreePath);
    assert.ok(diffAll.diff.includes("+export const answer = 99;"));
    assert.ok(diffAll.diff.includes("+new note"));

    const mergeOk = mergeWorktreeBack(repoDir, wt1.worktreePath, wt1.branch, wt1.baseBranch);
    assert.equal(mergeOk.ok, true);
    assert.equal(readFileSync(join(repoDir, "src", "app.ts"), "utf8"), "export const answer = 99;\n");

    cleanupWorktree(repoDir, wt1.worktreePath, wt1.branch, true);
    assert.equal(existsSync(wt1.worktreePath), false);

    // 2. Conflict path: divergent edits on main and worktree -> auto merge --abort + conflict list.
    const wt2 = createWorktree(repoDir, "conflict-case");
    writeFileSync(join(wt2.worktreePath, "README.md"), "# Demo Repo\nfrom worktree\n", "utf8");
    writeFileSync(join(repoDir, "README.md"), "# Demo Repo\nfrom main branch\n", "utf8");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "main edit"]);

    const mergeConflict = mergeWorktreeBack(repoDir, wt2.worktreePath, wt2.branch, wt2.baseBranch);
    assert.equal(mergeConflict.ok, false);
    assert.ok(mergeConflict.conflicts?.includes("README.md"));
    // Main repo must remain completely clean after automatic merge --abort.
    assert.equal(getGitStatus(repoDir).dirty, false);

    cleanupWorktree(repoDir, wt2.worktreePath, wt2.branch, true);
  } finally {
    cleanup();
  }
});

test("resolveLaunchPlan ignores sibling node.exe in nvm-windows style cmd shims & cli-probe returns catalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "conflux-v2-shim-"));
  try {
    const pkgDir = join(dir, "node_modules", "@openai", "codex", "bin");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(dir, "node.exe"), "fake-node");
    const script = join(pkgDir, "codex.js");
    writeFileSync(script, "// entry\n");
    writeFileSync(
      join(dir, "codex.cmd"),
      '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    const plan = resolveLaunchPlan(join(dir, "codex.cmd"), ["app-server"], "win32");
    assert.equal(plan.command, process.execPath);
    assert.equal(plan.args[0], resolve(script));

    const probes = probeLocalClis();
    assert.equal(probes.length, 4);
    assert.deepEqual(
      probes.map((p) => p.runtime).sort(),
      ["acp", "antigravity", "claude", "codex"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorktreePr auto-commits, pushes to origin, creates PR via gh CLI, and reuses existing PR", () => {
  const { repoDir, cleanup } = makeTempGitRepo();
  const bareOrigin = mkdtempSync(join(tmpdir(), "conflux-v2-origin-"));
  const ghShimDir = mkdtempSync(join(tmpdir(), "conflux-v2-gh-"));
  try {
    git(bareOrigin, ["init", "--bare"]);
    git(repoDir, ["remote", "add", "origin", bareOrigin]);
    git(repoDir, ["push", "-u", "origin", "main"]);

    const stateFile = join(ghShimDir, "pr-created.flag");
    const ghShim = join(ghShimDir, "gh-mock.cjs");
    writeFileSync(
      ghShim,
      `const fs = require("node:fs");
const args = process.argv.slice(2);
const flag = ${JSON.stringify(stateFile)};
if (args[0] === "pr" && args[1] === "view") {
  if (fs.existsSync(flag)) {
    process.stdout.write(JSON.stringify({ url: "https://github.com/demo/repo/pull/42" }) + "\\n");
    process.exit(0);
  }
  process.stderr.write("no pull requests found");
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "create") {
  fs.writeFileSync(flag, "1");
  process.stdout.write("https://github.com/demo/repo/pull/42\\n");
  process.exit(0);
}
process.exit(1);
`,
      "utf8",
    );

    const wt = createWorktree(repoDir, "pr-feature");
    writeFileSync(join(wt.worktreePath, "src", "pr-file.ts"), "export const pr = 1;\n", "utf8");

    const first = createWorktreePr(wt.worktreePath, wt.branch, "main", {
      title: "feat: lightweight PR",
      draft: true,
      ghPath: ghShim,
    });
    assert.equal(first.ok, true, first.message);
    assert.equal(first.existing, false);
    assert.equal(first.pr_url, "https://github.com/demo/repo/pull/42");

    // Second invocation after a follow-up edit pushes cleanly and links existing PR
    writeFileSync(join(wt.worktreePath, "src", "pr-file.ts"), "export const pr = 2;\n", "utf8");
    const second = createWorktreePr(wt.worktreePath, wt.branch, "main", { ghPath: ghShim });
    assert.equal(second.ok, true, second.message);
    assert.equal(second.existing, true);
    assert.equal(second.pr_url, "https://github.com/demo/repo/pull/42");

    cleanupWorktree(repoDir, wt.worktreePath, wt.branch, true);
  } finally {
    cleanup();
    rmSync(bareOrigin, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    rmSync(ghShimDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});
