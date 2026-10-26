import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHttpHost, resolveHttpPort } from "../config.js";

/** Save/restore the env vars the HTTP resolvers read, then clear them. */
function withHttpEnv(env: Record<string, string | undefined>, run: () => void): void {
  const keys = ["CONFLUX_HOST", "MUILTCHAT_HOST", "CONFLUX_PORT", "MUILTCHAT_PORT"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("legacy HTTP variables warn once each while new variables keep priority", () => {
  const originalEmitWarning = process.emitWarning;
  const warnings: string[] = [];
  process.emitWarning = ((warning: unknown) => {
    warnings.push(String(warning));
  }) as typeof process.emitWarning;
  try {
    withHttpEnv(
      {
        MUILTCHAT_HOST: "127.0.0.3",
        MUILTCHAT_PORT: "9529",
        CONFLUX_HOST: "127.0.0.2",
        CONFLUX_PORT: "9528",
      },
      () => {
        assert.equal(resolveHttpHost(), "127.0.0.2");
        assert.equal(resolveHttpPort(), 9528);
        resolveHttpHost();
        resolveHttpPort();
      },
    );
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  assert.equal(warnings.filter((warning) => warning.includes("MUILTCHAT_HOST")).length, 1);
  assert.equal(warnings.filter((warning) => warning.includes("MUILTCHAT_PORT")).length, 1);
  assert.ok(warnings.every((warning) => warning.includes("0.2.0")));
});

test("CONFLUX_HOST/CONFLUX_PORT are honoured", () => {
  withHttpEnv({ CONFLUX_HOST: "127.0.0.2", CONFLUX_PORT: "9528" }, () => {
    assert.equal(resolveHttpHost(), "127.0.0.2");
    assert.equal(resolveHttpPort(), 9528);
  });
});

test("legacy MUILTCHAT_HOST/MUILTCHAT_PORT still apply", () => {
  withHttpEnv({ MUILTCHAT_HOST: "127.0.0.3", MUILTCHAT_PORT: "9529" }, () => {
    assert.equal(resolveHttpHost(), "127.0.0.3");
    assert.equal(resolveHttpPort(), 9529);
  });
});

test("CONFLUX_* takes precedence over MUILTCHAT_* when both are set", () => {
  withHttpEnv(
    {
      CONFLUX_HOST: "127.0.0.2",
      MUILTCHAT_HOST: "127.0.0.3",
      CONFLUX_PORT: "9528",
      MUILTCHAT_PORT: "9529",
    },
    () => {
      assert.equal(resolveHttpHost(), "127.0.0.2");
      assert.equal(resolveHttpPort(), 9528);
    },
  );
});

test("invalid CONFLUX_PORT reports the new variable name", () => {
  withHttpEnv({ CONFLUX_PORT: "nope" }, () => {
    assert.throws(() => resolveHttpPort(), /invalid CONFLUX_PORT: nope/u);
  });
});

test("invalid MUILTCHAT_PORT (legacy) still reports the legacy name", () => {
  withHttpEnv({ MUILTCHAT_PORT: "nope" }, () => {
    assert.throws(() => resolveHttpPort(), /invalid MUILTCHAT_PORT: nope/u);
  });
});

test("no env falls back to defaults and explicit overrides win", () => {
  withHttpEnv({}, () => {
    assert.equal(resolveHttpHost(), "127.0.0.1");
    assert.equal(resolveHttpPort(), 9527);
    assert.equal(resolveHttpHost("0.0.0.0"), "0.0.0.0");
    assert.equal(resolveHttpPort(1234), 1234);
  });
});
