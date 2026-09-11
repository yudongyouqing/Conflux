import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_IDS,
  RUNTIME_REGISTRY,
  isPresetRuntime,
  runtimeDescriptor,
} from "../core/runtime-registry.js";
import {
  buildRuntimeArgs,
  buildHeadlessArgs,
  buildRuntimeEnv,
  RUNTIMES,
} from "../core/runtime-agents.js";
import { resumeCommand } from "../core/terminal.js";

test("registry covers the AgentRecall-validated agent set", () => {
  for (const id of ["claude", "codex", "cursor", "codebuddy", "codewiz"]) {
    assert.ok(RUNTIME_IDS.includes(id), `${id} registered`);
  }
  assert.equal(RUNTIMES.cursor.label, "Cursor Agent");
  assert.ok(isPresetRuntime("cursor") && !isPresetRuntime("nope"));
});

test("resume args follow family shapes (AgentRecall-validated)", () => {
  // codex family: `resume <id>`; claude family: `--resume <id>`; codewiz: `--session <id>`
  assert.deepEqual(RUNTIME_REGISTRY.codex.resumeArgs("abc"), ["resume", "abc"]);
  assert.deepEqual(RUNTIME_REGISTRY.claude.resumeArgs("abc"), ["--resume", "abc"]);
  assert.deepEqual(RUNTIME_REGISTRY.codebuddy.resumeArgs("abc"), ["--resume", "abc"]);
  assert.deepEqual(RUNTIME_REGISTRY.codewiz.resumeArgs("abc"), ["--session", "abc"]);
  assert.equal(resumeCommand("cursor", "s1", "cursor-agent"), "cursor-agent --resume s1");
});

test("buildRuntimeArgs: claude family gets operator prompt, others model only", () => {
  const claude = buildRuntimeArgs({ runtime: "claude", model: null, instructions: null });
  assert.ok(
    claude.some((a) => a.includes("muiltchat")),
    "operator prompt appended",
  );
  const cursor = buildRuntimeArgs({ runtime: "cursor", model: "big", instructions: "x" });
  assert.deepEqual(
    cursor,
    ["--model", "big"],
    "non-claude family: model only, no prompt injection",
  );
});

test("headless: supported runtimes produce prompts, others throw", () => {
  const claude = buildHeadlessArgs({ runtime: "claude", model: null, instructions: null }, "hi");
  assert.ok(claude.includes("-p") && claude.includes("hi"));
  const codex = buildHeadlessArgs({ runtime: "codex", model: null, instructions: null }, "hi");
  assert.deepEqual(codex, ["exec", "--", "hi"]);
  assert.throws(
    () => buildHeadlessArgs({ runtime: "cursor", model: null, instructions: null }),
    /no known headless mode/,
  );
});

test("env binding follows descriptor, not hardcoded claude check", () => {
  const base = { ...process.env };
  const env = buildRuntimeEnv(
    { runtime: "codex", base_url: "https://x", api_key: "sk", model: "m", extra_env: null, id: 1 },
    base,
  );
  assert.equal(env.OPENAI_BASE_URL, "https://x");
  assert.equal(env.OPENAI_API_KEY, "sk");
  // cursor: envBinding null → preset fields ignored, no accidental openai vars
  const env2 = buildRuntimeEnv(
    { runtime: "cursor", base_url: "https://x", api_key: "sk", model: "m", extra_env: null, id: 2 },
    base,
  );
  assert.equal(env2.OPENAI_BASE_URL, base.OPENAI_BASE_URL);
  assert.equal(env2.OPENAI_API_KEY, base.OPENAI_API_KEY);
});

test("unknown runtime id rejected", () => {
  assert.throws(() => runtimeDescriptor("vscode"), /unknown runtime/);
});
