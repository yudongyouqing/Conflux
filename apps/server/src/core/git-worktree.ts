import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  GitCreatePrResult,
  GitDiffResponse,
  GitFileChange,
  GitMergeResult,
  GitStatusResponse,
} from "@conflux/shared";
import { logger } from "../log.js";

const MAX_DIFF_CHARS = 120_000;
const MAX_UNTRACKED_PREVIEW_BYTES = 64 * 1024;
const WINDOWS_GIT_FALLBACK = "C:\\Program Files\\Git\\cmd\\git.exe";
const WINDOWS_GH_FALLBACK = "C:\\Program Files\\GitHub CLI\\gh.exe";

let cachedGitBin: string | null = null;
let cachedGhBin: string | null | undefined = undefined;

export function resolveGhBinary(override?: string | null): string | null {
  const explicit = override?.trim() || process.env.GH_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : explicit;
  if (cachedGhBin !== undefined) return cachedGhBin;
  const candidates =
    process.platform === "win32"
      ? ["gh", WINDOWS_GH_FALLBACK, "C:\\Program Files (x86)\\GitHub CLI\\gh.exe"]
      : ["gh"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
      cachedGhBin = bin;
      return cachedGhBin;
    } catch {
      // try next candidate
    }
  }
  cachedGhBin = null;
  return null;
}

/** Resolve a runnable git binary, supporting Windows hosts where git is not on PowerShell PATH. */
export function resolveGitBinary(): string {
  if (cachedGitBin) return cachedGitBin;
  const envPath = process.env.GIT_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    cachedGitBin = envPath;
    return cachedGitBin;
  }
  const candidates =
    process.platform === "win32"
      ? ["git", WINDOWS_GIT_FALLBACK, "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]
      : ["git"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
      cachedGitBin = bin;
      return cachedGitBin;
    } catch {
      // try next candidate
    }
  }
  cachedGitBin = "git";
  return cachedGitBin;
}

function runGit(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeoutMs?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const git = resolveGitBinary();
  try {
    const stdout = execFileSync(git, args, {
      cwd,
      env: opts.env ?? process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
    const stderr =
      typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? e.message ?? "");
    if (opts.allowFailure) return { ok: false, stdout, stderr };
    throw Object.assign(new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`), {
      statusCode: 400,
    });
  }
}

/** Normalize a filesystem path for consistent comparison (case-insensitive on Windows). */
export function normalizePathKey(dir: string): string {
  const resolved = resolve(dir).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const res = runGit(dir, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  return res.ok && res.stdout.trim() === "true";
}

export function getGitTopLevel(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const res = runGit(dir, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  return res.ok && res.stdout.trim() ? resolve(res.stdout.trim()) : null;
}

export function getCurrentBranch(dir: string): string | null {
  if (!isGitRepo(dir)) return null;
  const res = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  if (!res.ok) return null;
  const name = res.stdout.trim();
  return name && name !== "HEAD" ? name : null;
}

export function getDefaultBranch(dir: string): string | null {
  if (!isGitRepo(dir)) return null;
  const sym = runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    allowFailure: true,
  });
  if (sym.ok && sym.stdout.trim()) {
    return sym.stdout.trim().replace(/^origin\//, "");
  }
  return getCurrentBranch(dir);
}

function ensureWorktreeExcluded(projectRoot: string): void {
  const gitCommon = runGit(projectRoot, ["rev-parse", "--git-common-dir"], { allowFailure: true });
  if (!gitCommon.ok || !gitCommon.stdout.trim()) return;
  const commonDir = resolve(projectRoot, gitCommon.stdout.trim());
  const infoDir = join(commonDir, "info");
  const excludeFile = join(infoDir, "exclude");
  try {
    mkdirSync(infoDir, { recursive: true });
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (!existing.split(/\r?\n/).some((line) => line.trim() === ".conflux-worktrees/")) {
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(excludeFile, `${prefix}.conflux-worktrees/\n`, "utf8");
    }
  } catch (err) {
    logger.warn({ err, excludeFile }, "failed to write .git/info/exclude");
  }
}

export function slugifyWorktreeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = randomUUID().slice(0, 6);
  return cleaned ? `${cleaned}-${suffix}` : `agent-${suffix}`;
}

export interface CreatedWorktree {
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

/**
 * Create an isolated git worktree under `<projectRoot>/.conflux-worktrees/<slug>`
 * on branch `conflux/<slug>` from HEAD, excluding `.conflux-worktrees/` via
 * `.git/info/exclude` so the repository's `.gitignore` stays untouched.
 */
export function createWorktree(projectRoot: string, nameHint: string): CreatedWorktree {
  if (!isGitRepo(projectRoot)) {
    throw Object.assign(new Error("当前项目目录不是 Git 仓库，无法创建独立 Worktree"), {
      statusCode: 400,
    });
  }
  const headCheck = runGit(projectRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  if (!headCheck.ok) {
    throw Object.assign(new Error("当前 Git 仓库尚无任何提交（HEAD 不存在），无法创建 Worktree"), {
      statusCode: 400,
    });
  }
  ensureWorktreeExcluded(projectRoot);
  const baseBranch = getCurrentBranch(projectRoot) ?? "HEAD";
  const slug = slugifyWorktreeName(nameHint);
  const branch = `conflux/${slug}`;
  const containerDir = join(projectRoot, ".conflux-worktrees");
  mkdirSync(containerDir, { recursive: true });
  const worktreePath = join(containerDir, slug);
  runGit(projectRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  return { worktreePath, branch, baseBranch };
}

function parsePorcelainStatus(output: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine || rawLine.length < 3) continue;
    const x = rawLine[0];
    const y = rawLine[1];
    let filePath = rawLine.slice(3).trim();
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop()!.trim();
    }
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    if (filePath.startsWith(".conflux-worktrees/") || filePath === ".conflux-worktrees") {
      continue;
    }
    let status: GitFileChange["status"] = "modified";
    if (x === "?" && y === "?") status = "untracked";
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D"))
      status = "conflicted";
    else if (x === "A" || y === "A") status = "added";
    else if (x === "D" || y === "D") status = "deleted";
    else if (x === "R" || y === "R") status = "renamed";
    const staged = x !== " " && x !== "?";
    files.push({ path: filePath, status, staged });
  }
  return files;
}

export function getGitStatus(workdir: string, baseBranch: string | null = null): GitStatusResponse {
  if (!isGitRepo(workdir)) {
    return {
      is_git_repo: false,
      branch: null,
      base_branch: baseBranch,
      worktree_path: null,
      dirty: false,
      files: [],
    };
  }
  const branch = getCurrentBranch(workdir);
  const statusRes = runGit(workdir, ["status", "--porcelain=v1", "-uall"], { allowFailure: true });
  const files = statusRes.ok ? parsePorcelainStatus(statusRes.stdout) : [];

  // Enrich with numstat additions/deletions for tracked changes.
  const numstatRes = runGit(workdir, ["diff", "HEAD", "--numstat"], { allowFailure: true });
  if (numstatRes.ok && numstatRes.stdout) {
    const statMap = new Map<string, { additions: number; deletions: number }>();
    for (const line of numstatRes.stdout.split(/\r?\n/)) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const add = Number.parseInt(parts[0], 10);
      const del = Number.parseInt(parts[1], 10);
      if (Number.isFinite(add) && Number.isFinite(del)) {
        statMap.set(parts[2], { additions: add, deletions: del });
      }
    }
    for (const f of files) {
      const st = statMap.get(f.path);
      if (st) {
        f.additions = st.additions;
        f.deletions = st.deletions;
      }
    }
  }

  let ahead: number | undefined;
  let behind: number | undefined;
  if (baseBranch && branch && branch !== baseBranch) {
    const lr = runGit(workdir, ["rev-list", "--left-right", "--count", `${baseBranch}...HEAD`], {
      allowFailure: true,
    });
    if (lr.ok) {
      const [bStr, aStr] = lr.stdout.trim().split(/\s+/);
      const b = Number.parseInt(bStr ?? "", 10);
      const a = Number.parseInt(aStr ?? "", 10);
      if (Number.isFinite(a)) ahead = a;
      if (Number.isFinite(b)) behind = b;
    }
  }

  return {
    is_git_repo: true,
    branch,
    base_branch: baseBranch,
    worktree_path: workdir,
    dirty: files.length > 0,
    files,
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    gh_available: resolveGhBinary() !== null,
  };
}

function buildUntrackedDiff(workdir: string, relPath: string): string {
  const full = resolve(workdir, relPath);
  const relCheck = relative(resolve(workdir), full);
  if (relCheck.startsWith("..") || !existsSync(full)) return "";
  try {
    const st = statSync(full);
    if (!st.isFile()) return "";
    if (st.size > MAX_UNTRACKED_PREVIEW_BYTES) {
      return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n+[file too large to preview: ${st.size} bytes]\n`;
    }
    const content = readFileSync(full, "utf8");
    if (content.includes("\u0000")) {
      return `diff --git a/${relPath} b/${relPath}\nBinary file ${relPath} added\n`;
    }
    const lines = content.split(/\r?\n/);
    const body = lines.map((l) => `+${l}`).join("\n");
    return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  } catch {
    return "";
  }
}

export function getGitDiff(workdir: string, targetPath?: string | null): GitDiffResponse {
  if (!isGitRepo(workdir)) {
    return { path: targetPath ?? null, diff: "", truncated: false };
  }
  if (targetPath) {
    const resolvedTarget = resolve(workdir, targetPath);
    const rel = relative(resolve(workdir), resolvedTarget);
    if (rel.startsWith("..")) {
      throw Object.assign(new Error("invalid diff path outside workdir"), { statusCode: 400 });
    }
    const tracked = runGit(workdir, ["diff", "HEAD", "--", targetPath], { allowFailure: true });
    let diff = tracked.ok ? tracked.stdout : "";
    if (!diff.trim()) {
      diff = buildUntrackedDiff(workdir, targetPath);
    }
    const truncated = diff.length > MAX_DIFF_CHARS;
    return {
      path: targetPath,
      diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff,
      truncated,
    };
  }

  const headCheck = runGit(workdir, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  const tracked = headCheck.ok
    ? runGit(workdir, ["diff", "HEAD"], { allowFailure: true })
    : runGit(workdir, ["diff"], { allowFailure: true });
  let combined = tracked.ok ? tracked.stdout : "";

  const status = getGitStatus(workdir);
  for (const file of status.files) {
    if (file.status === "untracked" && combined.length < MAX_DIFF_CHARS) {
      combined += (combined && !combined.endsWith("\n") ? "\n" : "") + buildUntrackedDiff(workdir, file.path);
    }
  }
  const truncated = combined.length > MAX_DIFF_CHARS;
  return {
    path: null,
    diff: truncated ? combined.slice(0, MAX_DIFF_CHARS) : combined,
    truncated,
  };
}

/**
 * Merge a worktree branch cleanly back into the project's base branch.
 * Refuses if the main working tree has uncommitted changes; on merge conflict
 * automatically runs `git merge --abort` and returns the conflicted file list.
 */
export function mergeWorktreeBack(
  projectRoot: string,
  worktreePath: string,
  worktreeBranch: string,
  targetBranch: string,
): GitMergeResult {
  if (!isGitRepo(projectRoot)) {
    throw Object.assign(new Error("项目目录不是 Git 仓库"), { statusCode: 400 });
  }
  // Auto-commit uncommitted worktree changes onto the worktree branch so nothing is lost.
  const wtStatus = getGitStatus(worktreePath);
  if (wtStatus.dirty) {
    runGit(worktreePath, ["add", "-A"]);
    runGit(worktreePath, [
      "-c",
      "user.name=Conflux",
      "-c",
      "user.email=conflux@local",
      "commit",
      "-m",
      `feat(conflux): apply changes from ${basename(worktreePath)}`,
    ]);
  }

  const mainStatus = getGitStatus(projectRoot);
  if (mainStatus.dirty) {
    throw Object.assign(
      new Error("主工作区存在未提交改动，请先提交或暂存后再合并 Worktree 分支"),
      { statusCode: 409 },
    );
  }

  const currentMainBranch = getCurrentBranch(projectRoot);
  if (targetBranch && targetBranch !== "HEAD" && currentMainBranch !== targetBranch) {
    runGit(projectRoot, ["checkout", targetBranch]);
  }

  const mergeRes = runGit(
    projectRoot,
    [
      "-c",
      "user.name=Conflux",
      "-c",
      "user.email=conflux@local",
      "merge",
      "--no-ff",
      worktreeBranch,
      "-m",
      `Merge branch '${worktreeBranch}' into ${targetBranch}`,
    ],
    { allowFailure: true },
  );

  if (!mergeRes.ok) {
    const conflictRes = runGit(projectRoot, ["diff", "--name-only", "--diff-filter=U"], {
      allowFailure: true,
    });
    const conflicts = conflictRes.ok
      ? conflictRes.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    runGit(projectRoot, ["merge", "--abort"], { allowFailure: true });
    return {
      ok: false,
      merged_branch: worktreeBranch,
      target_branch: targetBranch,
      conflicts,
      message:
        conflicts.length > 0
          ? `合并发生冲突（已自动中止并恢复主分支），冲突文件：${conflicts.join(", ")}`
          : `合并失败（已自动中止）：${(mergeRes.stderr || mergeRes.stdout).trim()}`,
    };
  }

  return {
    ok: true,
    merged_branch: worktreeBranch,
    target_branch: targetBranch,
    message: `已将 ${worktreeBranch} 合并回 ${targetBranch}`,
  };
}

function runGh(
  cwd: string,
  ghBin: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const isNodeScript = /\.(?:cjs|mjs|js)$/i.test(ghBin);
  const cmd = isNodeScript ? process.execPath : ghBin;
  const cmdArgs = isNodeScript ? [ghBin, ...args] : args;
  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : e.stderr?.toString("utf8") ?? e.message ?? "gh command failed",
    };
  }
}

/**
 * Lightweight Paseo-style PR creation: auto-commit worktree changes if dirty,
 * push branch to origin, and delegate PR lookup/creation to local `gh` CLI.
 */
export function createWorktreePr(
  worktreePath: string,
  worktreeBranch: string,
  baseBranch: string,
  opts: { title?: string; body?: string; draft?: boolean; ghPath?: string } = {},
): GitCreatePrResult {
  const ghBin = resolveGhBinary(opts.ghPath);
  if (!ghBin) {
    return {
      ok: false,
      branch: worktreeBranch,
      base_branch: baseBranch,
      pr_url: null,
      message: "未检测到 GitHub CLI (gh)，请先安装并执行 gh auth login。",
    };
  }

  const wtStatus = getGitStatus(worktreePath);
  if (wtStatus.dirty) {
    runGit(worktreePath, ["add", "-A"]);
    runGit(worktreePath, [
      "-c",
      "user.name=Conflux",
      "-c",
      "user.email=conflux@local",
      "commit",
      "-m",
      opts.title?.trim() || `feat(conflux): ${basename(worktreePath)}`,
    ]);
  }

  const pushRes = runGit(worktreePath, ["push", "-u", "origin", worktreeBranch], {
    allowFailure: true,
    timeoutMs: 30_000,
  });
  if (!pushRes.ok) {
    return {
      ok: false,
      branch: worktreeBranch,
      base_branch: baseBranch,
      pr_url: null,
      message: `推送分支失败：${(pushRes.stderr || pushRes.stdout).trim().slice(0, 300)}`,
    };
  }

  const existingRes = runGh(worktreePath, ghBin, ["pr", "view", worktreeBranch, "--json", "url"]);
  if (existingRes.ok) {
    try {
      const parsed = JSON.parse(existingRes.stdout) as { url?: unknown };
      if (typeof parsed.url === "string" && parsed.url.startsWith("http")) {
        return {
          ok: true,
          branch: worktreeBranch,
          base_branch: baseBranch,
          pr_url: parsed.url,
          existing: true,
          message: `已推送最新提交并更新已有 PR`,
        };
      }
    } catch {
      // fall through to creation
    }
  }

  const createArgs = ["pr", "create", "--base", baseBranch, "--head", worktreeBranch];
  if (opts.title?.trim()) {
    createArgs.push("--title", opts.title.trim(), "--body", opts.body?.trim() ?? "");
  } else {
    createArgs.push("--fill");
  }
  if (opts.draft) createArgs.push("--draft");

  const createRes = runGh(worktreePath, ghBin, createArgs);
  if (!createRes.ok) {
    return {
      ok: false,
      branch: worktreeBranch,
      base_branch: baseBranch,
      pr_url: null,
      message: `创建 PR 失败：${(createRes.stderr || createRes.stdout).trim().slice(0, 300)}`,
    };
  }

  const urlMatch = createRes.stdout.match(/https?:\/\/\S+/);
  const prUrl = urlMatch ? urlMatch[0].trim() : null;
  return {
    ok: true,
    branch: worktreeBranch,
    base_branch: baseBranch,
    pr_url: prUrl,
    existing: false,
    message: prUrl ? "已推送分支并创建 PR" : "已执行 gh pr create",
  };
}

export function cleanupWorktree(
  projectRoot: string,
  worktreePath: string,
  branchName?: string | null,
  force = true,
): void {
  if (isGitRepo(projectRoot) && existsSync(worktreePath)) {
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath];
    const res = runGit(projectRoot, args, { allowFailure: true });
    if (!res.ok) {
      rmSync(worktreePath, { recursive: true, force: true });
      runGit(projectRoot, ["worktree", "prune"], { allowFailure: true });
    }
  } else if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  if (isGitRepo(projectRoot)) {
    runGit(projectRoot, ["worktree", "prune"], { allowFailure: true });
    if (branchName && branchName.startsWith("conflux/")) {
      runGit(projectRoot, ["branch", "-D", branchName], { allowFailure: true });
    }
  }
}

export interface CheckpointSnapshot {
  refName: string;
  treeSha: string;
  commitSha: string;
}

/**
 * Create an invisible Git snapshot of the entire working tree (tracked + untracked)
 * using a throwaway GIT_INDEX_FILE. Leaves the user's staging area, HEAD, git log,
 * and git stash 100% untouched.
 */
export function createInvisibleCheckpoint(
  workdir: string,
  threadId: string,
  runId: number | string,
): CheckpointSnapshot | null {
  if (!isGitRepo(workdir)) return null;
  const headRes = runGit(workdir, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  if (!headRes.ok || !headRes.stdout.trim()) return null;
  const headSha = headRes.stdout.trim();

  const tempIndex = join(tmpdir(), `conflux-idx-${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try {
    // Seed temporary index from HEAD, then capture full working tree minus .conflux-worktrees.
    runGit(workdir, ["read-tree", headSha], { env });
    runGit(workdir, ["add", "-A", "--", ".", ":!.conflux-worktrees"], { env, allowFailure: true });
    const treeRes = runGit(workdir, ["write-tree"], { env });
    const treeSha = treeRes.stdout.trim();
    if (!treeSha) return null;

    const commitRes = runGit(
      workdir,
      [
        "-c",
        "user.name=Conflux Checkpoint",
        "-c",
        "user.email=checkpoint@conflux.local",
        "commit-tree",
        treeSha,
        "-p",
        headSha,
        "-m",
        `conflux invisible checkpoint ${threadId}/${runId}`,
      ],
      { env },
    );
    const commitSha = commitRes.stdout.trim();
    const safeThread = threadId.replace(/[^A-Za-z0-9._-]/g, "_");
    const refName = `refs/conflux/checkpoints/${safeThread}/${runId}`;
    runGit(workdir, ["update-ref", refName, commitSha]);
    return { refName, treeSha, commitSha };
  } catch (err) {
    logger.warn({ err, workdir, threadId, runId }, "invisible checkpoint creation skipped");
    return null;
  } finally {
    rmSync(tempIndex, { force: true });
  }
}

/**
 * Restore a working directory exactly to a previously captured invisible checkpoint,
 * removing untracked files added after the checkpoint while preserving `.git` and
 * `.conflux-worktrees/` and leaving `HEAD` / `git log` / `git stash` untouched.
 */
export function rollbackToCheckpoint(workdir: string, refName: string): void {
  if (!isGitRepo(workdir)) {
    throw Object.assign(new Error("工作目录不是 Git 仓库，无法回滚快照"), { statusCode: 400 });
  }
  const verify = runGit(workdir, ["rev-parse", "--verify", refName], { allowFailure: true });
  if (!verify.ok) {
    throw Object.assign(new Error(`快照引用不存在：${refName}`), { statusCode: 404 });
  }
  const snapCommit = verify.stdout.trim();
  const snapTree = runGit(workdir, ["rev-parse", `${snapCommit}^{tree}`]).stdout.trim();

  // Compute files present now (excluding .conflux-worktrees) vs files in the snapshot tree.
  const statusNow = getGitStatus(workdir);
  const currentUntracked = statusNow.files
    .filter((f) => f.status === "untracked")
    .map((f) => f.path);

  const snapListRes = runGit(workdir, ["ls-tree", "-r", "--name-only", snapTree]);
  const snapFiles = new Set(
    snapListRes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Remove untracked files created after the checkpoint.
  for (const relPath of currentUntracked) {
    if (!snapFiles.has(relPath)) {
      const full = resolve(workdir, relPath);
      const check = relative(resolve(workdir), full);
      if (!check.startsWith("..") && !relPath.startsWith(".conflux-worktrees")) {
        rmSync(full, { recursive: true, force: true });
      }
    }
  }

  // Restore snapshot files into working tree using a temporary index so the user's real index stays clean.
  const tempIndex = join(tmpdir(), `conflux-restore-${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try {
    runGit(workdir, ["read-tree", snapTree], { env });
    runGit(workdir, ["checkout-index", "-a", "-f"], { env });
  } finally {
    rmSync(tempIndex, { force: true });
  }

  // Remove tracked files that did not exist in the snapshot tree.
  const trackedNow = runGit(workdir, ["ls-files"]).stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const relPath of trackedNow) {
    if (!snapFiles.has(relPath)) {
      const full = resolve(workdir, relPath);
      const check = relative(resolve(workdir), full);
      if (!check.startsWith("..")) {
        rmSync(full, { force: true });
      }
    }
  }
}

/** Delete all internal checkpoint refs created for a thread. */
export function deleteThreadCheckpoints(workdir: string, threadId: string): number {
  if (!isGitRepo(workdir)) return 0;
  const safeThread = threadId.replace(/[^A-Za-z0-9._-]/g, "_");
  const prefix = `refs/conflux/checkpoints/${safeThread}/`;
  const listed = runGit(workdir, ["for-each-ref", "--format=%(refname)", prefix], {
    allowFailure: true,
  });
  if (!listed.ok) return 0;
  let removed = 0;
  for (const ref of listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const res = runGit(workdir, ["update-ref", "-d", ref], { allowFailure: true });
    if (res.ok) removed++;
  }
  return removed;
}
