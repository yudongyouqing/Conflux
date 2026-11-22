import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CliBinaryStatus,
  NativeCliProviderState,
  ProviderPreset,
  RuntimeId,
  TerminalSettings,
} from "@conflux/shared";
import type { DB } from "./db.js";
import { nowIso } from "./db.js";
import { getSetting, setSetting } from "./app-settings.js";
import { redactExtraEnv } from "./runtime-agents.js";
import { resolveOnPath } from "./terminal.js";

const PRESETS_KEY = "cli_provider_presets";

interface StoredProviderPreset {
  id: string;
  name: string;
  runtime: RuntimeId;
  base_url: string | null;
  model: string | null;
  api_key: string | null;
  extra_env: string | null;
  updated_at: string;
}

export interface SaveProviderPresetInput {
  id?: string;
  name: string;
  runtime: RuntimeId;
  base_url?: string | null;
  model?: string | null;
  api_key?: string | null;
  extra_env?: string | null;
}

export interface ApplyNativeProviderInput {
  runtime: RuntimeId;
  base_url?: string | null;
  model?: string | null;
  api_key?: string | null;
  extra_env?: string | null;
}

export function probeCliBinaries(
  settings: Pick<TerminalSettings, "claude_path" | "codex_path">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliBinaryStatus[] {
  const specs: Array<{ runtime: RuntimeId; label: string; configured: string }> = [
    { runtime: "claude", label: "Claude Code", configured: settings.claude_path || "claude" },
    { runtime: "codex", label: "Codex", configured: settings.codex_path || "codex" },
  ];
  return specs.map((spec) => {
    const resolved = resolveOnPath(spec.configured, baseEnv, platform);
    return {
      runtime: spec.runtime,
      label: spec.label,
      configured: spec.configured,
      resolved_path: resolved,
      available: resolved !== null,
    };
  });
}

function toPublicPreset(p: StoredProviderPreset): ProviderPreset {
  return {
    id: p.id,
    name: p.name,
    runtime: p.runtime,
    base_url: p.base_url,
    model: p.model,
    api_key_configured: Boolean(p.api_key && p.api_key.length > 0),
    extra_env: redactExtraEnv(p.extra_env, "mask"),
    updated_at: p.updated_at,
  };
}

function loadStoredPresets(db: DB): StoredProviderPreset[] {
  const raw = getSetting(db, PRESETS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredProviderPreset =>
        Boolean(
          item &&
            typeof item === "object" &&
            typeof (item as StoredProviderPreset).id === "string" &&
            typeof (item as StoredProviderPreset).name === "string" &&
            ((item as StoredProviderPreset).runtime === "claude" ||
              (item as StoredProviderPreset).runtime === "codex"),
        ),
    );
  } catch {
    return [];
  }
}

function persistStoredPresets(db: DB, presets: StoredProviderPreset[]): void {
  setSetting(db, PRESETS_KEY, JSON.stringify(presets));
}

export function listProviderPresets(db: DB): ProviderPreset[] {
  return loadStoredPresets(db).map(toPublicPreset);
}

export function saveProviderPreset(db: DB, input: SaveProviderPresetInput): ProviderPreset {
  const name = input.name.trim();
  if (!name) {
    throw Object.assign(new Error("preset name is required"), { statusCode: 400 });
  }
  if (input.runtime !== "claude" && input.runtime !== "codex") {
    throw Object.assign(new Error("runtime must be claude or codex"), { statusCode: 400 });
  }
  let normalizedExtraEnv: string | null = null;
  if (input.extra_env && input.extra_env.trim()) {
    try {
      const parsed = JSON.parse(input.extra_env) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("extra_env must be a JSON object");
      }
      normalizedExtraEnv = JSON.stringify(parsed);
    } catch {
      throw Object.assign(new Error("extra_env must be a valid JSON object"), { statusCode: 400 });
    }
  }

  const all = loadStoredPresets(db);
  const existing = input.id ? all.find((p) => p.id === input.id) : undefined;
  const next: StoredProviderPreset = {
    id: existing?.id ?? randomUUID().slice(0, 12),
    name,
    runtime: input.runtime,
    base_url: input.base_url?.trim() || null,
    model: input.model?.trim() || null,
    api_key:
      input.api_key !== undefined
        ? input.api_key?.trim() || null
        : (existing?.api_key ?? null),
    extra_env: normalizedExtraEnv,
    updated_at: nowIso(),
  };

  const updated = existing
    ? all.map((p) => (p.id === existing.id ? next : p))
    : [next, ...all];
  persistStoredPresets(db, updated);
  return toPublicPreset(next);
}

export function deleteProviderPreset(db: DB, id: string): boolean {
  const all = loadStoredPresets(db);
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return false;
  persistStoredPresets(db, next);
  return true;
}

export function getStoredProviderPreset(db: DB, id: string): StoredProviderPreset | null {
  return loadStoredPresets(db).find((p) => p.id === id) ?? null;
}

// ---- Native CLI config inspection & atomic backup-then-write ----------------

function readClaudeNativeState(homeDir: string): NativeCliProviderState {
  const configPath = join(homeDir, ".claude", "settings.json");
  if (!existsSync(configPath)) {
    return {
      runtime: "claude",
      config_path: configPath,
      exists: false,
      base_url: null,
      model: null,
      api_key_configured: false,
      env_keys: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      env?: Record<string, unknown>;
    };
    const env =
      parsed && typeof parsed.env === "object" && parsed.env && !Array.isArray(parsed.env)
        ? parsed.env
        : {};
    const str = (k: string) => (typeof env[k] === "string" && env[k].trim() ? env[k].trim() : null);
    return {
      runtime: "claude",
      config_path: configPath,
      exists: true,
      base_url: str("ANTHROPIC_BASE_URL"),
      model: str("ANTHROPIC_MODEL"),
      api_key_configured: Boolean(str("ANTHROPIC_AUTH_TOKEN") || str("ANTHROPIC_API_KEY")),
      env_keys: Object.keys(env),
    };
  } catch {
    return {
      runtime: "claude",
      config_path: configPath,
      exists: true,
      base_url: null,
      model: null,
      api_key_configured: false,
      env_keys: [],
    };
  }
}

function readCodexNativeState(homeDir: string): NativeCliProviderState {
  const configPath = join(homeDir, ".codex", "config.toml");
  const authPath = join(homeDir, ".codex", "auth.json");
  const exists = existsSync(configPath) || existsSync(authPath);
  let model: string | null = null;
  let baseUrl: string | null = null;
  let apiKeyConfigured = false;
  const envKeys: string[] = [];

  if (existsSync(configPath)) {
    try {
      const toml = readFileSync(configPath, "utf8");
      const modelMatch = /^\s*model\s*=\s*"([^"]*)"/m.exec(toml);
      if (modelMatch && modelMatch[1].trim()) model = modelMatch[1].trim();
      const baseMatch = /^\s*base_url\s*=\s*"([^"]*)"/m.exec(toml);
      if (baseMatch && baseMatch[1].trim()) baseUrl = baseMatch[1].trim();
    } catch {
      /* ignore unreadable config */
    }
  }
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      if (auth && typeof auth === "object") {
        envKeys.push(...Object.keys(auth));
        apiKeyConfigured =
          typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim().length > 0;
      }
    } catch {
      /* ignore unreadable auth.json */
    }
  }

  return {
    runtime: "codex",
    config_path: configPath,
    exists,
    base_url: baseUrl,
    model,
    api_key_configured: apiKeyConfigured,
    env_keys: envKeys,
  };
}

export function readNativeCliProviders(homeDir: string = homedir()): NativeCliProviderState[] {
  return [readClaudeNativeState(homeDir), readCodexNativeState(homeDir)];
}

function writeAtomicWithBackup(filePath: string, content: string, mode?: number): string | null {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  let backupPath: string | null = null;
  if (existsSync(filePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${filePath}.conflux-bak-${stamp}`;
    writeFileSync(backupPath, readFileSync(filePath), mode ? { mode } : undefined);
  }
  const tmpPath = `${filePath}.conflux-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, mode ? { encoding: "utf8", mode } : "utf8");
  renameSync(tmpPath, filePath);
  return backupPath;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function upsertTomlTopLevelKey(toml: string, key: string, value: string): string {
  const lines = toml.split(/\r?\n/);
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  let firstTableIdx = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstTableIdx === -1) firstTableIdx = lines.length;

  for (let i = 0; i < firstTableIdx; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = `${key} = ${tomlString(value)}`;
      return lines.join("\n");
    }
  }
  lines.splice(0, 0, `${key} = ${tomlString(value)}`);
  return lines.join("\n");
}

function upsertCodexProviderSection(toml: string, baseUrl: string): string {
  const sectionHeader = "[model_providers.conflux]";
  const block = [
    sectionHeader,
    'name = "Conflux"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
  ].join("\n");

  const lines = toml.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === sectionHeader);
  if (startIdx >= 0) {
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    lines.splice(startIdx, endIdx - startIdx, ...block.split("\n"), "");
    return lines.join("\n");
  }
  const trimmed = toml.trimEnd();
  return `${trimmed ? trimmed + "\n\n" : ""}${block}\n`;
}

export function applyNativeCliProvider(
  input: ApplyNativeProviderInput,
  homeDir: string = homedir(),
): { config_path: string; backup_path: string | null; native: NativeCliProviderState } {
  if (input.runtime === "claude") {
    const configPath = join(homeDir, ".claude", "settings.json");
    let root: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          root = parsed as Record<string, unknown>;
        }
      } catch {
        throw Object.assign(new Error("~/.claude/settings.json is not valid JSON"), {
          statusCode: 409,
        });
      }
    }
    const existingEnv =
      root.env && typeof root.env === "object" && !Array.isArray(root.env)
        ? { ...(root.env as Record<string, unknown>) }
        : {};

    if (input.base_url?.trim()) existingEnv.ANTHROPIC_BASE_URL = input.base_url.trim();
    if (input.model?.trim()) existingEnv.ANTHROPIC_MODEL = input.model.trim();
    if (input.api_key?.trim()) existingEnv.ANTHROPIC_AUTH_TOKEN = input.api_key.trim();
    if (input.extra_env?.trim()) {
      try {
        const extra = JSON.parse(input.extra_env) as Record<string, unknown>;
        if (extra && typeof extra === "object" && !Array.isArray(extra)) {
          for (const [k, v] of Object.entries(extra)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              existingEnv[k] = String(v);
            }
          }
        }
      } catch {
        throw Object.assign(new Error("extra_env must be a valid JSON object"), {
          statusCode: 400,
        });
      }
    }
    root.env = existingEnv;
    const backupPath = writeAtomicWithBackup(configPath, JSON.stringify(root, null, 2) + "\n", 0o600);
    return {
      config_path: configPath,
      backup_path: backupPath,
      native: readClaudeNativeState(homeDir),
    };
  }

  // Codex: ~/.codex/config.toml + ~/.codex/auth.json
  const configPath = join(homeDir, ".codex", "config.toml");
  const authPath = join(homeDir, ".codex", "auth.json");
  let toml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (input.model?.trim()) {
    toml = upsertTomlTopLevelKey(toml, "model", input.model.trim());
  }
  if (input.base_url?.trim()) {
    toml = upsertTomlTopLevelKey(toml, "model_provider", "conflux");
    toml = upsertCodexProviderSection(toml, input.base_url.trim());
  }
  const backupPath = writeAtomicWithBackup(configPath, toml.endsWith("\n") ? toml : `${toml}\n`);

  if (input.api_key?.trim()) {
    let auth: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      try {
        const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          auth = parsed as Record<string, unknown>;
        }
      } catch {
        auth = {};
      }
    }
    auth.OPENAI_API_KEY = input.api_key.trim();
    writeAtomicWithBackup(authPath, JSON.stringify(auth, null, 2) + "\n", 0o600);
  }

  return {
    config_path: configPath,
    backup_path: backupPath,
    native: readCodexNativeState(homeDir),
  };
}
