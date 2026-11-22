import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CliBinaryStatus,
  NativeCliProviderState,
  RuntimeId,
  TerminalSettings,
} from "@conflux/shared";
import { resolveOnPath } from "./terminal.js";

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

/** Read-only inspection of native CLI provider configs (~/.claude/settings.json, ~/.codex/config.toml). */
export function readNativeCliProviders(homeDir: string = homedir()): NativeCliProviderState[] {
  return [readClaudeNativeState(homeDir), readCodexNativeState(homeDir)];
}
