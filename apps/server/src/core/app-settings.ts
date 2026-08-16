import type { DB } from "./db.js";
import type { TerminalChoice, TerminalSettings } from "@muiltchat/shared";

const TERMINAL_KEY = "terminal";

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  terminal: "wt",
  claude_path: "claude",
  codex_path: "codex",
};

const TERMINAL_CHOICES: TerminalChoice[] = ["wt", "powershell", "cmd", "wezterm"];

export function getSetting(db: DB, key: string): string | null {
  const row = db
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/** Read the terminal opener config, filling in defaults for missing fields. */
export function getTerminalSettings(db: DB): TerminalSettings {
  const raw = getSetting(db, TERMINAL_KEY);
  if (!raw) return { ...DEFAULT_TERMINAL_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<TerminalSettings>;
    return {
      terminal: TERMINAL_CHOICES.includes(parsed.terminal as TerminalChoice)
        ? (parsed.terminal as TerminalChoice)
        : DEFAULT_TERMINAL_SETTINGS.terminal,
      claude_path:
        typeof parsed.claude_path === "string" && parsed.claude_path.trim()
          ? parsed.claude_path.trim()
          : DEFAULT_TERMINAL_SETTINGS.claude_path,
      codex_path:
        typeof parsed.codex_path === "string" && parsed.codex_path.trim()
          ? parsed.codex_path.trim()
          : DEFAULT_TERMINAL_SETTINGS.codex_path,
    };
  } catch {
    return { ...DEFAULT_TERMINAL_SETTINGS };
  }
}

/** Validate + persist a partial terminal config, returning the merged result. */
export function saveTerminalSettings(
  db: DB,
  input: Partial<TerminalSettings>
): TerminalSettings {
  const merged = getTerminalSettings(db);
  if (input.terminal !== undefined) {
    if (!TERMINAL_CHOICES.includes(input.terminal)) {
      throw new Error(`unknown terminal: ${input.terminal} (expected wt | cmd | wezterm)`);
    }
    merged.terminal = input.terminal;
  }
  if (typeof input.claude_path === "string") {
    merged.claude_path = input.claude_path.trim() || DEFAULT_TERMINAL_SETTINGS.claude_path;
  }
  if (typeof input.codex_path === "string") {
    merged.codex_path = input.codex_path.trim() || DEFAULT_TERMINAL_SETTINGS.codex_path;
  }
  setSetting(db, TERMINAL_KEY, JSON.stringify(merged));
  return merged;
}
