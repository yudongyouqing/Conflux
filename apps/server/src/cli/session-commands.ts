import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type Client = "codex" | "claude";

export function installSessionCommands(options: {
  client: Client | "all";
  home?: string;
  codexHome?: string;
  claudeHome?: string;
  force?: boolean;
}) {
  const content = readFileSync(resolve(__dirname, "../../skills/conflux/SKILL.md"), "utf8");
  const home = options.home ?? homedir();
  const clients: Client[] = options.client === "all" ? ["codex", "claude"] : [options.client];
  const targets = clients.map((client) => {
    const base =
      client === "codex"
        ? (options.codexHome ??
          (!options.home ? process.env.CODEX_HOME : undefined) ??
          join(home, ".codex"))
        : (options.claudeHome ??
          (!options.home ? process.env.CLAUDE_CONFIG_DIR : undefined) ??
          join(home, ".claude"));
    const path = join(base, "skills", "conflux", "SKILL.md");
    const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (previous !== null && previous !== content && !options.force) {
      throw new Error(
        `Existing Conflux skill differs: ${path}. Use --force to back it up before replacing.`,
      );
    }
    return { client, path, previous };
  });
  return targets.map(({ client, path, previous }) => {
    if (previous === content) return { client, path, changed: false, backup: undefined };
    mkdirSync(dirname(path), { recursive: true });
    const backup = previous === null ? undefined : `${path}.conflux-bak-${randomUUID()}`;
    if (backup) copyFileSync(path, backup);
    writeFileSync(path, content, { encoding: "utf8", flag: previous === null ? "wx" : "w" });
    return { client, path, changed: true, backup };
  });
}
