import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ConfluxDataBundle } from "@muiltchat/shared";
import { startHttpServer } from "../http/server.js";

const timestamp = "2026-09-01T00:00:00.000Z";

function bundleWithSession(id: string): ConfluxDataBundle {
  return {
    format: "conflux-data",
    version: 1,
    exported_at: timestamp,
    scope: "global",
    sessions: [
      {
        id,
        name: "Interface session",
        description: null,
        project_dir: null,
        status: "active",
        created_at: timestamp,
        last_heartbeat_at: timestamp,
        metadata: null,
        runtime: null,
        identity_source: "cli",
        runtime_pid: null,
      },
    ],
    context_entries: [],
    messages: [],
    edges: [],
    agents: [],
    conversations: [],
    turns: [],
    runtime_agents: [],
  };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.MUILTCHAT_HOME;
  delete env.CONFLUX_HOME;
  delete env.MUILTCHAT_PORT;
  delete env.MUILTCHAT_HOST;
  return env;
}

test("HTTP data routes import and export a validated bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "conflux-http-transfer-"));
  const bundle = bundleWithSession("http-interface-session");
  const previousPort = process.env.MUILTCHAT_PORT;
  const previousHost = process.env.MUILTCHAT_HOST;
  delete process.env.MUILTCHAT_PORT;
  delete process.env.MUILTCHAT_HOST;

  let app: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    app = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      overrideDataDir: root,
    });

    const imported = await app.inject({
      method: "POST",
      url: "/data/import",
      payload: { bundle, conflict: "skip" },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(JSON.parse(imported.body).imported, 1);

    const exported = await app.inject({
      method: "GET",
      url: "/data/export?scope=global",
    });
    assert.equal(exported.statusCode, 200, exported.body);
    const exportedBundle = JSON.parse(exported.body) as ConfluxDataBundle;
    assert.ok(exportedBundle.sessions.some((session) => session.id === "http-interface-session"));
    assert.equal(exportedBundle.format, "conflux-data");

    const invalid = await app.inject({
      method: "POST",
      url: "/data/import",
      payload: { bundle: { ...bundle, format: "invalid" } },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(JSON.parse(invalid.body).code, "BAD_REQUEST");

    const notFound = await app.inject({
      method: "GET",
      url: "/route-that-does-not-exist",
    });
    assert.equal(notFound.statusCode, 404, notFound.body);
    assert.equal(JSON.parse(notFound.body).code, "NOT_FOUND");
  } finally {
    if (app) await app.close();
    if (previousPort === undefined) delete process.env.MUILTCHAT_PORT;
    else process.env.MUILTCHAT_PORT = previousPort;
    if (previousHost === undefined) delete process.env.MUILTCHAT_HOST;
    else process.env.MUILTCHAT_HOST = previousHost;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI data commands round-trip a bundle through files", () => {
  const root = mkdtempSync(join(tmpdir(), "conflux-cli-transfer-"));
  const dataDir = join(root, "data");
  const input = join(root, "input.json");
  const output = join(root, "output.json");
  const repoRoot = resolve(__dirname, "../../../..");
  const entry = resolve(__dirname, "../index.ts");
  writeFileSync(input, JSON.stringify(bundleWithSession("cli-interface-session")), "utf8");

  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: repoRoot,
      env: cleanEnv(),
      encoding: "utf8",
    });

  try {
    const imported = run([
      "--data-dir",
      dataDir,
      "data",
      "import",
      "--file",
      input,
    ]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).imported, 1);

    const exported = run([
      "--data-dir",
      dataDir,
      "data",
      "export",
      "--scope",
      "global",
      "--output",
      output,
    ]);
    assert.equal(exported.status, 0, exported.stderr);
    const result = JSON.parse(readFileSync(output, "utf8")) as ConfluxDataBundle;
    assert.equal(result.format, "conflux-data");
    assert.ok(result.sessions.some((session) => session.id === "cli-interface-session"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
