import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeAgent,
  deleteRuntimeAgent,
  getRuntimeAgent,
  listRuntimeAgents,
  buildRuntimeEnv,
  buildRuntimeArgs,
  cleanTerminalEnv,
  startRuntimeAgent,
  RUNTIMES,
} from "../core/runtime-agents.js";
import { makeDb } from "./helpers.js";

const { db, cleanup } = makeDb();
after(cleanup);

describe("runtime agent CRUD", () => {
  it("creates, lists and deletes a preset", () => {
    const a = createRuntimeAgent(db, {
      name: "worker",
      runtime: "claude",
      workdir: "C:\\work\\proj",
      model: "claude-sonnet-4",
      base_url: "https://relay.example.com",
      api_key: "sk-test",
    });
    assert.equal(a.runtime, "claude");
    assert.equal(a.model, "claude-sonnet-4");
    assert.ok(listRuntimeAgents(db).some((x) => x.id === a.id));

    assert.equal(deleteRuntimeAgent(db, a.id), true);
    assert.equal(getRuntimeAgent(db, a.id), null);
  });

  it("rejects unknown runtimes and malformed extra_env", () => {
    assert.throws(() => createRuntimeAgent(db, { name: "x", runtime: "cursor" }));
    assert.throws(() =>
      createRuntimeAgent(db, { name: "x", runtime: "claude", extra_env: "{oops" })
    );
    assert.throws(() =>
      createRuntimeAgent(db, { name: "x", runtime: "claude", extra_env: '["a"]' })
    );
  });
});

describe("buildRuntimeEnv", () => {
  it("claude with preset key: replaces inherited creds, injects channel + agent tag", () => {
    const env = buildRuntimeEnv(
      {
        id: 7,
        runtime: "claude",
        base_url: "https://relay.example.com",
        api_key: "sk-new",
        model: "claude-sonnet-4",
        extra_env: '{"CUSTOM_FLAG":"1"}',
      },
      {
        ANTHROPIC_AUTH_TOKEN: "inherited-secret",
        ANTHROPIC_API_KEY: "inherited-key",
        PATH: "C:\\bin",
      } as NodeJS.ProcessEnv
    );
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-new"); // replaced, not inherited
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, "https://relay.example.com");
    assert.equal(env.ANTHROPIC_MODEL, "claude-sonnet-4");
    assert.equal(env.CUSTOM_FLAG, "1");
    assert.equal(env.MUILTCHAT_AGENT_ID, "7");
    assert.equal(env.MUILTCHAT_AGENT_RUNTIME, "claude");
    assert.equal(env.PATH, "C:\\bin");
  });

  it("claude without preset key: keeps inherited auth (spawned CLI must stay usable)", () => {
    const env = buildRuntimeEnv(
      { id: 8, runtime: "claude", base_url: null, api_key: null, model: null, extra_env: null },
      { ANTHROPIC_AUTH_TOKEN: "inherited-secret" } as NodeJS.ProcessEnv
    );
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "inherited-secret");
    assert.equal(env.MUILTCHAT_AGENT_ID, "8");
  });

  it("codex: maps channel onto OpenAI env", () => {
    const env = buildRuntimeEnv(
      { id: 3, runtime: "codex", base_url: "https://oa.example.com/v1", api_key: "k", model: "gpt-5", extra_env: null },
      { OPENAI_API_KEY: "old" } as NodeJS.ProcessEnv
    );
    assert.equal(env.OPENAI_API_KEY, "k");
    assert.equal(env.OPENAI_BASE_URL, "https://oa.example.com/v1");
  });
});

describe("cleanTerminalEnv", () => {
  it("keeps OS essentials, drops session-scoped Claude vars", () => {
    const env = cleanTerminalEnv({
      PATH: "C:\\bin",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\tmp",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ANTHROPIC_AUTH_TOKEN: "session-secret",
      ANTHROPIC_MODEL: "glm-5.2",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    } as NodeJS.ProcessEnv);
    assert.equal(env.PATH, "C:\\bin");
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.TEMP, "C:\\tmp");
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_MODEL, undefined);
  });
});

describe("buildRuntimeArgs", () => {
  it("claude: model + append-system-prompt from instructions", () => {
    assert.deepEqual(
      buildRuntimeArgs({ runtime: "claude", model: "m", instructions: "be terse" }),
      ["--model", "m", "--append-system-prompt", "be terse"]
    );
  });
  it("codex: model only", () => {
    assert.deepEqual(buildRuntimeArgs({ runtime: "codex", model: "gpt-5", instructions: "x" }), [
      "--model",
      "gpt-5",
    ]);
  });
});

describe("startRuntimeAgent", () => {
  it("refuses on non-Windows platforms and missing presets/workdirs", () => {
    assert.throws(
      () => startRuntimeAgent(db, 99999),
      /not found/
    );
    const a = createRuntimeAgent(db, { name: "w", runtime: "claude" });
    assert.throws(
      () => startRuntimeAgent(db, a.id, { platform: "linux" }),
      /Windows-only/
    );
    assert.throws(
      () => startRuntimeAgent(db, createRuntimeAgent(db, { name: "baddir", runtime: "claude", workdir: "Z:\\no\\such\\dir" }).id),
      /workdir does not exist/
    );
  });
});

describe("RUNTIMES catalog", () => {
  it("covers claude and codex with executable env overrides", () => {
    assert.deepEqual(Object.keys(RUNTIMES).sort(), ["claude", "codex"]);
    assert.equal(RUNTIMES.claude.executableEnv, "CLAUDE_PATH");
    assert.equal(RUNTIMES.codex.executableEnv, "CODEX_PATH");
  });
});
