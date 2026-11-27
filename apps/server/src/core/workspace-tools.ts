import { exec } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join, relative, resolve } from "node:path";
import type {
  WorkspaceFileContent,
  WorkspaceFileEntry,
  WorkspaceTerminalRunResult,
} from "@conflux/shared";

const MAX_FILE_READ_BYTES = 256 * 1024;
const MAX_TERM_OUTPUT_CHARS = 64_000;
const SKIP_TREE_DIRS = new Set([
  ".git",
  "node_modules",
  ".conflux-worktrees",
  ".worktrees",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "target",
]);

function resolveInsideWorkspace(workdir: string, subPath = ""): string {
  const absRoot = resolve(workdir);
  const cleaned = subPath.trim().replace(/^[/\\]+/, "");
  const target = cleaned ? resolve(absRoot, cleaned) : absRoot;
  const rel = relative(absRoot, target);
  if (rel.startsWith("..") || rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw Object.assign(new Error("path escapes workspace directory"), { statusCode: 400 });
  }
  return target;
}

/**
 * Execute a shell command inside a workspace's exact `workdir` for the
 * embedded terminal panel. Uses a bounded timeout and output cap.
 */
export function execWorkspaceCommand(
  workdir: string,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<WorkspaceTerminalRunResult> {
  const cmd = command.trim();
  if (!cmd) {
    throw Object.assign(new Error("command is required"), { statusCode: 400 });
  }
  const absCwd = resolve(workdir);
  if (!existsSync(absCwd) || !statSync(absCwd).isDirectory()) {
    throw Object.assign(new Error(`工作目录不存在：${absCwd}`), { statusCode: 400 });
  }

  const startedAt = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env };
  let shellCmd = cmd;
  if (process.platform === "win32") {
    const extraDirs = ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\GitHub CLI"].filter((d) =>
      existsSync(d),
    );
    const currentPath = env.Path ?? env.PATH ?? "";
    const missing = extraDirs.filter((d) => !currentPath.toLowerCase().includes(d.toLowerCase()));
    if (missing.length > 0) {
      const merged = `${missing.join(";")};${currentPath}`;
      env.Path = merged;
      env.PATH = merged;
    }
    shellCmd = `chcp 65001 >nul && ${cmd}`;
  }

  return new Promise((resolvePromise) => {
    exec(
      shellCmd,
      {
        cwd: absCwd,
        env,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      },
      (err, stdout, stderr) => {
        const outStr = String(stdout ?? "").slice(0, MAX_TERM_OUTPUT_CHARS);
        const errStr = String(stderr ?? "").slice(0, MAX_TERM_OUTPUT_CHARS);
        const exitCode =
          err && typeof (err as { code?: unknown }).code === "number"
            ? Number((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolvePromise({
          ok: !err,
          command: cmd,
          cwd: absCwd,
          stdout: outStr,
          stderr: errStr || (err && !outStr ? err.message : ""),
          exit_code: exitCode,
          duration_ms: Date.now() - startedAt,
        });
      },
    );
  });
}

/** List immediate children inside a workspace directory for the File Explorer. */
export function listWorkspaceDirectory(workdir: string, subPath = ""): WorkspaceFileEntry[] {
  const absRoot = resolve(workdir);
  const targetDir = resolveInsideWorkspace(absRoot, subPath);
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    return [];
  }
  const entries = readdirSync(targetDir, { withFileTypes: true });
  const results: WorkspaceFileEntry[] = [];
  for (const ent of entries) {
    if (ent.isDirectory() && SKIP_TREE_DIRS.has(ent.name)) continue;
    const full = join(targetDir, ent.name);
    const rel = relative(absRoot, full).replace(/\\/g, "/");
    if (ent.isDirectory()) {
      results.push({ name: ent.name, path: rel, kind: "dir" });
    } else if (ent.isFile()) {
      let size: number | undefined;
      try {
        size = statSync(full).size;
      } catch {
        size = undefined;
      }
      results.push({ name: ent.name, path: rel, kind: "file", size });
    }
  }
  results.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return results;
}

/** Read a single file inside the workspace with size cap and binary detection. */
export function readWorkspaceFile(workdir: string, relPath: string): WorkspaceFileContent {
  const absRoot = resolve(workdir);
  const target = resolveInsideWorkspace(absRoot, relPath);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw Object.assign(new Error(`文件不存在：${relPath}`), { statusCode: 404 });
  }
  const st = statSync(target);
  const raw = readFileSync(target);
  const truncated = raw.length > MAX_FILE_READ_BYTES;
  const slice = truncated ? raw.subarray(0, MAX_FILE_READ_BYTES) : raw;
  const binary = slice.includes(0);
  return {
    path: relative(absRoot, target).replace(/\\/g, "/"),
    content: binary ? "" : slice.toString("utf8"),
    size: st.size,
    truncated,
    binary,
  };
}

function probeTcpPort(port: number, timeoutMs = 180): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

const DEFAULT_PREVIEW_PORTS = [5173, 3000, 4173, 5174, 3001, 8080, 8000];

/** Probe common local dev server ports in parallel so the Live Preview pane auto-discovers active apps. */
export async function detectLocalPreviewUrls(
  ports: number[] = DEFAULT_PREVIEW_PORTS,
): Promise<Array<{ port: number; url: string }>> {
  const checks = await Promise.all(
    ports.map(async (port) => ((await probeTcpPort(port)) ? { port, url: `http://localhost:${port}` } : null)),
  );
  return checks.filter((item): item is { port: number; url: string } => item !== null);
}
