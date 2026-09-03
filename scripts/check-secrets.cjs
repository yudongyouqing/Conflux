const fs = require("node:fs");
const path = require("node:path");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".electron-dev",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "release",
  "superpowers",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const RULES = [
  { category: "private-key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { category: "credential", pattern: /\bsk-(?:live-|proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { category: "token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
  { category: "cloud-credential", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { category: "credential", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  {
    category: "credential",
    pattern: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9/+._=-]{20,}/i,
  },
];

function scanText(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    const categories = new Set();
    for (const rule of RULES) {
      if (rule.pattern.test(line)) categories.add(rule.category);
    }
    for (const category of categories) {
      findings.push({ line: index + 1, category });
    }
  });
  return findings;
}

function scanFiles(files) {
  const findings = [];
  for (const file of files) {
    const absolute = path.resolve(file);
    const text = fs.readFileSync(absolute, "utf8");
    for (const finding of scanText(text)) {
      findings.push({ file: absolute, ...finding });
    }
  }
  return findings;
}

function collectFiles(root) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.name.includes(".test.") || entry.name.endsWith(".db")) continue;
      if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
    }
  }
  visit(root);
  return files;
}

function main() {
  const root = path.resolve(__dirname, "..");
  const files = process.argv.slice(2).map((file) => path.resolve(process.cwd(), file));
  const findings = scanFiles(files.length > 0 ? files : collectFiles(root));
  if (findings.length === 0) {
    process.stdout.write(`Secret scan passed (${files.length > 0 ? files.length : "repository"} scope).\n`);
    return;
  }
  for (const finding of findings) {
    process.stdout.write(`${finding.file}:${finding.line} [${finding.category}]\n`);
  }
  process.exitCode = 1;
}

module.exports = { collectFiles, scanFiles, scanText };

if (require.main === module) main();
