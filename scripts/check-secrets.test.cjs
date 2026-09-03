const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const { scanFiles, scanText } = require("./check-secrets.cjs");

test("allows documented placeholder values", () => {
  assert.deepEqual(scanText("OPENAI_API_KEY=your-key-here"), []);
  assert.deepEqual(scanText("ANTHROPIC_API_KEY=example-token"), []);
});

test("flags credential-shaped values without returning their contents", () => {
  const findings = scanText(
    "OPENAI_API_KEY=sk-live-12345678901234567890\nAuthorization: Bearer abcdefghijklmnop1234567890"
  );
  assert.equal(findings.length, 2);
  assert.equal(findings[0].line, 1);
  assert.match(findings[0].category, /credential/);
  assert.equal("match" in findings[0], false);
  assert.equal("value" in findings[0], false);
  assert.match(findings[1].category, /token/);
});

test("flags private key and cloud access key shapes", () => {
  const findings = scanText(
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
  );
  assert.deepEqual(
    findings.map((finding) => finding.category),
    ["private-key", "cloud-credential"]
  );
});

test("scans explicit files and reports paths and line numbers only", () => {
  const root = mkdtempSync(join(tmpdir(), "conflux-secret-test-"));
  const safe = join(root, "safe.txt");
  const secret = join(root, "secret.txt");
  writeFileSync(safe, "OPENAI_API_KEY=your-key-here\n", "utf8");
  writeFileSync(secret, "token: sk-ant-live-12345678901234567890\n", "utf8");
  try {
    const findings = scanFiles([safe, secret]);
    assert.deepEqual(findings, [
      { file: secret, line: 1, category: "credential" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
