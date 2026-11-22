import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers.js";
import {
  applyNativeCliProvider,
  deleteProviderPreset,
  listProviderPresets,
  readNativeCliProviders,
  saveProviderPreset,
} from "../core/cli-providers.js";

test("provider presets round-trip with secret redaction on public reads", () => {
  const { db, cleanup } = makeDb();
  try {
    const saved = saveProviderPreset(db, {
      name: "Anthropic Relay",
      runtime: "claude",
      base_url: "https://relay.example.com",
      model: "claude-sonnet-4-5",
      api_key: "sk-ant-secret-value",
      extra_env: JSON.stringify({ HTTP_PROXY: "http://127.0.0.1:7890", MY_TOKEN: "secret-tok" }),
    });
    assert.equal(saved.api_key_configured, true);
    assert.equal("api_key" in saved, false);
    assert.deepEqual(JSON.parse(saved.extra_env!), {
      HTTP_PROXY: "http://127.0.0.1:7890",
      MY_TOKEN: "••••",
    });

    const list = listProviderPresets(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, saved.id);

    assert.equal(deleteProviderPreset(db, saved.id), true);
    assert.equal(listProviderPresets(db).length, 0);
  } finally {
    cleanup();
  }
});

test("applyNativeCliProvider preserves existing Claude hooks and writes a backup", () => {
  const home = mkdtempSync(join(tmpdir(), "conflux-cli-provider-"));
  try {
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ command: "keep-me" }] }, env: { EXISTING: "1" } }, null, 2),
      "utf8",
    );

    const result = applyNativeCliProvider(
      {
        runtime: "claude",
        base_url: "https://relay.example.com",
        model: "claude-sonnet-4-5",
        api_key: "sk-ant-new",
      },
      home,
    );
    assert.ok(result.backup_path && existsSync(result.backup_path), "backup created");
    assert.equal(result.native.base_url, "https://relay.example.com");
    assert.equal(result.native.model, "claude-sonnet-4-5");
    assert.equal(result.native.api_key_configured, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: unknown;
      env: Record<string, string>;
    };
    assert.deepEqual(written.hooks, { Stop: [{ command: "keep-me" }] });
    assert.equal(written.env.EXISTING, "1");
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://relay.example.com");
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-new");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("applyNativeCliProvider preserves Codex MCP config while updating model, provider, and auth.json", () => {
  const home = mkdtempSync(join(tmpdir(), "conflux-codex-provider-"));
  try {
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const configPath = join(codexDir, "config.toml");
    writeFileSync(
      configPath,
      '[mcp_servers.conflux]\ncommand = "npx"\nargs = ["tsx", "apps/server/src/index.ts", "mcp"]\n',
      "utf8",
    );

    const result = applyNativeCliProvider(
      {
        runtime: "codex",
        base_url: "https://codex-relay.example.com/v1",
        model: "gpt-5-codex",
        api_key: "sk-openai-new",
      },
      home,
    );
    assert.ok(result.backup_path && existsSync(result.backup_path), "config.toml backup created");
    const toml = readFileSync(configPath, "utf8");
    assert.ok(toml.includes("[mcp_servers.conflux]"), "MCP server block preserved");
    assert.ok(toml.includes('model = "gpt-5-codex"'));
    assert.ok(toml.includes('base_url = "https://codex-relay.example.com/v1"'));

    const auth = JSON.parse(readFileSync(join(codexDir, "auth.json"), "utf8")) as Record<string, string>;
    assert.equal(auth.OPENAI_API_KEY, "sk-openai-new");

    const states = readNativeCliProviders(home);
    const codexState = states.find((s) => s.runtime === "codex")!;
    assert.equal(codexState.model, "gpt-5-codex");
    assert.equal(codexState.base_url, "https://codex-relay.example.com/v1");
    assert.equal(codexState.api_key_configured, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
