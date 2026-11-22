import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeCliProviders } from "../core/cli-providers.js";

test("readNativeCliProviders inspects Claude settings.json and Codex config.toml read-only", () => {
  const home = mkdtempSync(join(tmpdir(), "conflux-cli-provider-"));
  try {
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: "https://relay.example.com",
            ANTHROPIC_MODEL: "claude-sonnet-4-5",
            ANTHROPIC_AUTH_TOKEN: "sk-ant-test",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      'model = "gpt-5-codex"\n[model_providers.custom]\nbase_url = "https://codex-relay.example.com/v1"\n',
      "utf8",
    );
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-openai-test" }),
      "utf8",
    );

    const states = readNativeCliProviders(home);
    const claude = states.find((s) => s.runtime === "claude")!;
    const codex = states.find((s) => s.runtime === "codex")!;

    assert.equal(claude.exists, true);
    assert.equal(claude.base_url, "https://relay.example.com");
    assert.equal(claude.model, "claude-sonnet-4-5");
    assert.equal(claude.api_key_configured, true);

    assert.equal(codex.exists, true);
    assert.equal(codex.base_url, "https://codex-relay.example.com/v1");
    assert.equal(codex.model, "gpt-5-codex");
    assert.equal(codex.api_key_configured, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readNativeCliProviders returns empty non-throwing state when native configs do not exist", () => {
  const home = mkdtempSync(join(tmpdir(), "conflux-cli-empty-"));
  try {
    const states = readNativeCliProviders(home);
    assert.equal(states.length, 2);
    for (const s of states) {
      assert.equal(s.exists, false);
      assert.equal(s.base_url, null);
      assert.equal(s.model, null);
      assert.equal(s.api_key_configured, false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
