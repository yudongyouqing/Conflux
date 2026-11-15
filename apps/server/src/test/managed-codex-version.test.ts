import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSupportedCodexVersion,
  parseCodexCliVersion,
  SUPPORTED_CODEX_CLI_MINOR,
} from "../core/managed-codex/version.js";

// The handshake gate: the executor speaks the protocol of ONE certified
// codex minor, so a drifted (or unrecognizable) app-server must fail before
// any thread is created — never limp on with a silently incompatible peer.

test("parses the codex version out of real-world userAgents", () => {
  assert.equal(
    parseCodexCliVersion("codex_cli_rs/0.164.0 (Windows 11; x86_64) Codex/1.0.0"),
    "0.164.0",
  );
  // Ubuntu's OS version must not shadow the codex version (it never comes first)
  assert.equal(
    parseCodexCliVersion("codex_cli_rs/0.164.1 (Ubuntu 22.04.5 LTS; x86_64)"),
    "0.164.1",
  );
  assert.equal(parseCodexCliVersion("codex_shim/0.164.0-fixture"), "0.164.0");
  assert.equal(parseCodexCliVersion(undefined), null);
  assert.equal(parseCodexCliVersion("no version anywhere"), null);
});

test("accepts any patch of the supported minor", () => {
  assert.doesNotThrow(() => assertSupportedCodexVersion("codex_cli_rs/0.164.0 (Windows 11)"));
  assert.doesNotThrow(() => assertSupportedCodexVersion("codex_shim/0.164.9-fixture"));
});

test("rejects other minors with a named, actionable error", () => {
  assert.throws(
    () => assertSupportedCodexVersion("codex_cli_rs/99.99.99 (Windows 11; x86_64)"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /99\.99\.99/);
      assert.match(err.message, new RegExp(SUPPORTED_CODEX_CLI_MINOR));
      assert.equal((err as { statusCode?: number }).statusCode, 400);
      return true;
    },
  );
});

test("rejects userAgents without a parsable version", () => {
  assert.throws(() => assertSupportedCodexVersion("garbage"), /cannot determine codex version/);
  assert.throws(() => assertSupportedCodexVersion(undefined), /cannot determine codex version/);
});
