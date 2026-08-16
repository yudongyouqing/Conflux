import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeArgs,
  buildRuntimeEnv,
  RUNTIME_OPERATOR_PROMPT,
} from "../core/runtime-agents.js";

test("claude args always carry the operator prompt", () => {
  const args = buildRuntimeArgs({ runtime: "claude", model: null, instructions: null });
  const i = args.indexOf("--append-system-prompt");
  assert.ok(i >= 0, "--append-system-prompt present");
  assert.equal(args[i + 1], RUNTIME_OPERATOR_PROMPT);
});

test("user instructions extend, not replace, the operator prompt", () => {
  const args = buildRuntimeArgs({
    runtime: "claude",
    model: "sonnet",
    instructions: "只处理部署相关问题",
  });
  assert.deepEqual(args.slice(0, 2), ["--model", "sonnet"]);
  const i = args.indexOf("--append-system-prompt");
  const prompt = args[i + 1];
  assert.ok(prompt.startsWith(RUNTIME_OPERATOR_PROMPT));
  assert.ok(prompt.includes("只处理部署相关问题"));
});

test("codex args stay model-only (no system-prompt injection)", () => {
  assert.deepEqual(
    buildRuntimeArgs({ runtime: "codex", model: "gpt-5", instructions: "x" }),
    ["--model", "gpt-5"]
  );
});

test("buildRuntimeEnv tags the agent id for MCP-side session linking", () => {
  const env = buildRuntimeEnv({
    id: 7,
    runtime: "claude",
    base_url: null,
    api_key: "sk-test",
    model: null,
    extra_env: null,
  });
  assert.equal(env.MUILTCHAT_AGENT_ID, "7");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "replaced, not inherited");
});
