#!/usr/bin/env node
// Mirror .agents/skills -> .claude/skills. .agents is the single editing
// source; .claude/skills is a generated artifact (Claude Code reads only
// that path). Re-run after editing/adding a skill.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, ".agents", "skills");
const dest = path.join(root, ".claude", "skills");

if (!fs.existsSync(src)) {
  console.error(`source missing: ${src}`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
}

console.log(`skills synced: ${fs.readdirSync(dest).join(", ")}`);
