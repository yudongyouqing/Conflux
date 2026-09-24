#!/usr/bin/env node
/**
 * Seed a throwaway Conflux database with deterministic fixture data for the
 * screenshot rig (#113). Real user data is never touched — the rig points
 * the server at a temp dir via CONFLUX_HOME. Usage: node seed-fixture.mjs [dir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const home = process.argv[2] ?? mkdtempSync(join(tmpdir(), "conflux-capture-"));
const r = spawnSync("npx", ["tsx", join(ROOT, "scripts/capture/seed-core.ts"), home], {
  cwd: ROOT,
  encoding: "utf8",
  stdio: "inherit",
});
process.exit(r.status ?? 1);
