import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CliProbeEntry, RuntimeId } from "@conflux/shared";
import type { DB } from "./db.js";
import { getRuntimeSettings } from "./runtime-env.js";

const MODEL_CATALOG: Record<RuntimeId, string[]> = {
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  codex: ["gpt-5.4", "gpt-5.3-codex", "o3"],
  antigravity: ["gemini-3.1-pro", "gemini-2.5-pro", "claude-sonnet-4-6"],
  acp: [],
};

const LABELS: Record<RuntimeId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  acp: "自定义 ACP",
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveExecutableOnPath(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/[\\/]/.test(trimmed)) {
    const abs = resolve(trimmed);
    if (isFile(abs)) return abs;
    if (process.platform === "win32") {
      for (const ext of [".exe", ".cmd", ".bat", ".ps1"]) {
        if (isFile(`${abs}${ext}`)) return `${abs}${ext}`;
      }
    }
    return null;
  }
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const exts =
    process.platform === "win32"
      ? [".exe", ".cmd", ".bat", ".com"]
      : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = resolve(dir, `${trimmed}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function readCliVersion(resolvedPath: string): string | null {
  try {
    const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedPath);
    const res = isCmd
      ? spawnSync(process.env.comspec ?? "cmd.exe", ["/d", "/s", "/c", `"${resolvedPath}" --version`], {
          encoding: "utf8",
          timeout: 8000,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawnSync(resolvedPath, ["--version"], {
          encoding: "utf8",
          timeout: 8000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
    if (res.status !== 0 || !res.stdout) return null;
    const first = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return first ? first.slice(0, 120) : null;
  } catch {
    return null;
  }
}

let cachedProbes: { at: number; entries: CliProbeEntry[] } | null = null;
const PROBE_TTL_MS = 60_000;

export function probeLocalClis(db?: DB, opts: { force?: boolean } = {}): CliProbeEntry[] {
  if (!opts.force && cachedProbes && Date.now() - cachedProbes.at < PROBE_TTL_MS) {
    return cachedProbes.entries;
  }
  const settings = db ? getRuntimeSettings(db) : null;
  const specs: Array<{ runtime: RuntimeId; executable: string }> = [
    { runtime: "antigravity", executable: process.env.ANTIGRAVITY_PATH || settings?.antigravity_path || "agy" },
    { runtime: "claude", executable: process.env.CLAUDE_PATH || settings?.claude_path || "claude" },
    { runtime: "codex", executable: process.env.CODEX_PATH || settings?.codex_path || "codex" },
    { runtime: "acp", executable: process.env.ACP_AGENT_PATH?.trim() || settings?.acp_path?.trim() || "" },
  ];

  const versionCache = new Map<string, string | null>();
  const entries: CliProbeEntry[] = specs.map(({ runtime, executable }) => {
    const resolved = !executable
      ? null
      : existsSync(executable) && isFile(executable)
        ? resolve(executable)
        : resolveExecutableOnPath(executable);
    let version: string | null = null;
    if (resolved) {
      if (versionCache.has(resolved)) {
        version = versionCache.get(resolved) ?? null;
      } else {
        version = readCliVersion(resolved);
        versionCache.set(resolved, version);
      }
    }
    return {
      runtime,
      label: LABELS[runtime],
      executable,
      available: resolved !== null,
      resolved_path: resolved,
      version,
      models: MODEL_CATALOG[runtime],
      supports_steer: true,
    };
  });

  cachedProbes = { at: Date.now(), entries };
  return entries;
}

export function clearCliProbeCache(): void {
  cachedProbes = null;
}

export function getSameSeriesModels(runtime: RuntimeId): string[] {
  return MODEL_CATALOG[runtime] ?? [];
}
