import { test } from "node:test";
import assert from "node:assert/strict";

import { publicError } from "../core/db.js";

test("maps SQLITE_BUSY to an actionable stable error", () => {
  assert.deepEqual(publicError({ code: "SQLITE_BUSY" }), {
    code: "DATA_LOCKED",
    message: "数据库正在被另一个进程使用，请稍后重试或关闭重复的 Conflux 实例。",
  });
});

test("maps corrupt database errors without exposing the raw error", () => {
  const result = publicError(
    Object.assign(new Error("password=top-secret"), { code: "SQLITE_CORRUPT" }),
    { dataDir: "C:\\Conflux\\data" }
  );
  assert.equal(result.code, "DATA_CORRUPT");
  assert.match(result.message, /C:\\Conflux\\data/);
  assert.doesNotMatch(result.message, /top-secret/);
});

test("maps HTTP status errors to stable public codes", () => {
  assert.deepEqual(publicError({ statusCode: 404, message: "session not found" }), {
    code: "NOT_FOUND",
    message: "session not found",
  });
  assert.deepEqual(publicError({ statusCode: 409, message: "conflict" }), {
    code: "CONFLICT",
    message: "conflict",
  });
});
