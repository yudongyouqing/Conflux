import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RuntimeId, SystemNetworkInfo } from "@conflux/shared";
import { DEFAULT_HTTP_PORT } from "../config.js";

function isTailscaleIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isPrivateLanIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

/**
 * Auto-detect reachable IPv4 addresses on this machine, prioritizing Tailscale
 * CGNAT addresses (`100.64.0.0/10`) then RFC1918 LAN addresses, so remote devices
 * can copy-paste a single zero-token MCP URL without manual IP lookup.
 */
export function detectLocalNetworkInfo(port = DEFAULT_HTTP_PORT): SystemNetworkInfo {
  const ifaces = networkInterfaces();
  const tailscaleIps: string[] = [];
  const lanIps: string[] = [];
  const otherIps: string[] = [];

  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (isTailscaleIpv4(info.address)) tailscaleIps.push(info.address);
      else if (isPrivateLanIpv4(info.address)) lanIps.push(info.address);
      else otherIps.push(info.address);
    }
  }

  const addresses = [...new Set([...tailscaleIps, ...lanIps, ...otherIps, "127.0.0.1"])];
  const preferredIp = tailscaleIps[0] ?? lanIps[0] ?? otherIps[0] ?? "127.0.0.1";
  const hubUrl = `http://${preferredIp}:${port}`;
  return {
    hostname: hostname() || "localhost",
    addresses,
    preferred_ip: preferredIp,
    port,
    hub_url: hubUrl,
    mcp_http_url: `${hubUrl}/mcp`,
  };
}

export type HookTargetCli = "claude" | "codex" | "agy";

export interface HookInstallResult {
  cli: HookTargetCli;
  config_path: string;
  hub_url: string;
  events: string[];
  command: string;
}

function readJsonOrEmpty(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Install Tier-1 native CLI hooks (idempotently preserving all user settings)
 * so live CLI sessions register 1:1 by session_id + cwd + host and check their
 * Conflux inbox without spawning orphan headless threads.
 */
export function installCliHook(
  cli: HookTargetCli,
  opts: { hubUrl: string; homeDir?: string; confluxBin?: string },
): HookInstallResult {
  const home = resolve(opts.homeDir ?? homedir());
  const hubUrl = opts.hubUrl.replace(/\/+$/, "");
  const bin = opts.confluxBin?.trim() || "npx conflux";

  if (cli === "claude") {
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    const settings = readJsonOrEmpty(settingsPath);
    const hooks =
      settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
        ? { ...(settings.hooks as Record<string, unknown>) }
        : {};

    const checkCmd = `${bin} hook check --runtime claude --hub ${hubUrl}`;
    const offlineCmd = `${bin} hook check --runtime claude --offline --hub ${hubUrl}`;
    const eventSpecs: Array<[string, string]> = [
      ["SessionStart", checkCmd],
      ["UserPromptSubmit", checkCmd],
      ["Stop", checkCmd],
      ["SessionEnd", offlineCmd],
    ];

    for (const [eventName, command] of eventSpecs) {
      const existingList = Array.isArray(hooks[eventName]) ? [...(hooks[eventName] as unknown[])] : [];
      const filtered = existingList.filter((item) => {
        const text = JSON.stringify(item ?? {});
        return !text.includes("conflux hook check");
      });
      filtered.push({
        matcher: "",
        hooks: [{ type: "command", command }],
      });
      hooks[eventName] = filtered;
    }

    settings.hooks = hooks;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return {
      cli,
      config_path: settingsPath,
      hub_url: hubUrl,
      events: eventSpecs.map(([name]) => name),
      command: checkCmd,
    };
  }

  const runtimeName = cli === "codex" ? "codex" : "antigravity";
  const configPath =
    cli === "codex"
      ? join(home, ".codex", "conflux-hook.json")
      : join(home, ".gemini", "conflux-hook.json");
  mkdirSync(dirname(configPath), { recursive: true });
  const command = `${bin} hook check --runtime ${runtimeName} --hub ${hubUrl}`;
  const payload = {
    hub_url: hubUrl,
    runtime: runtimeName,
    events: ["session_start", "turn_stop", "session_end"],
    check_command: command,
    offline_command: `${bin} hook check --runtime ${runtimeName} --offline --hub ${hubUrl}`,
    installed_at: new Date().toISOString(),
  };
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {
    cli,
    config_path: configPath,
    hub_url: hubUrl,
    events: payload.events,
    command,
  };
}

export interface OriginalDirectoryWakeSpec {
  executable: string;
  args: string[];
  cwd: string;
}

/**
 * Tier-2 idle wakeup plan: strictly validates and enters the EXACT original
 * working directory (`cwd`) and resumes the exact original `session_id`.
 * Never spawns an orphan headless thread in a temporary or fallback directory.
 */
export function buildOriginalDirectoryWakePlan(input: {
  runtime: RuntimeId;
  sessionId: string;
  cwd: string;
  prompt: string;
  executableOverride?: string;
}): OriginalDirectoryWakeSpec {
  const sessionId = input.sessionId.trim();
  const prompt = input.prompt.trim();
  const cwd = resolve(input.cwd.trim());
  if (!sessionId) {
    throw Object.assign(new Error("session_id is required for original-directory wake"), {
      statusCode: 400,
    });
  }
  if (!prompt) {
    throw Object.assign(new Error("prompt is required for original-directory wake"), {
      statusCode: 400,
    });
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw Object.assign(
      new Error(`原工作目录不存在，已拒绝无头唤醒：${cwd}`),
      { statusCode: 400 },
    );
  }

  if (input.runtime === "codex") {
    return {
      executable: input.executableOverride?.trim() || "codex",
      args: ["exec", "resume", sessionId, prompt],
      cwd,
    };
  }
  if (input.runtime === "antigravity" || input.runtime === "acp") {
    return {
      executable: input.executableOverride?.trim() || "agy",
      args: ["chat", "--resume", sessionId, prompt],
      cwd,
    };
  }
  return {
    executable: input.executableOverride?.trim() || "claude",
    args: ["--resume", sessionId, "-p", prompt],
    cwd,
  };
}

export function executeOriginalDirectoryWake(input: {
  runtime: RuntimeId;
  sessionId: string;
  cwd: string;
  prompt: string;
  executableOverride?: string;
  timeoutMs?: number;
}): { ok: boolean; cwd: string; executable: string; args: string[]; stdout: string; stderr: string } {
  const plan = buildOriginalDirectoryWakePlan(input);
  try {
    const stdout = execFileSync(plan.executable, plan.args, {
      cwd: plan.cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, ...plan, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      ok: false,
      ...plan,
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? ""),
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : (e.stderr?.toString("utf8") ?? e.message ?? "wake failed"),
    };
  }
}
