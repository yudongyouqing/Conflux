import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const crateDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const cargoBinDir = join(homedir(), ".cargo", "bin");
const cargoExe =
  process.platform === "win32" && existsSync(join(cargoBinDir, "cargo.exe"))
    ? join(cargoBinDir, "cargo.exe")
    : "cargo";

const env = { ...process.env };
if (existsSync(cargoBinDir)) {
  const sep = process.platform === "win32" ? ";" : ":";
  const cur = env.PATH ?? env.Path ?? "";
  if (!cur.toLowerCase().includes(cargoBinDir.toLowerCase())) {
    const merged = `${cargoBinDir}${sep}${cur}`;
    env.PATH = merged;
    env.Path = merged;
  }
}

const args = process.argv.slice(2);
const res = spawnSync(cargoExe, args, {
  cwd: crateDir,
  env,
  stdio: "inherit",
});
process.exit(res.status ?? 1);
