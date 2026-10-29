import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { waitForChildCondition } from "./child-condition.js";

test("child readiness permits startup slower than the former three-second limit", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => console.log('ready'), 3200)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  try {
    await waitForChildCondition(child, () => output.includes("ready"), { describe: () => output });
  } finally {
    child.kill();
  }
});

test("child readiness rejects on early exit with diagnostics instead of waiting for timeout", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "console.error('startup failed'); process.exit(7)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await assert.rejects(
    waitForChildCondition(child, () => false, { describe: () => stderr }),
    /exited.*7.*startup failed/s,
  );
});

test("child readiness checks already-received output and removes its listeners", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const before = child.listenerCount("error");
    await waitForChildCondition(child, () => true);
    assert.equal(child.listenerCount("error"), before);
  } finally {
    child.kill();
  }
});
