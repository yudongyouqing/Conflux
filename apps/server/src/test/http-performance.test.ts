import assert from "node:assert/strict";
import { test } from "node:test";
import { requestDurationMs } from "../http/server.js";

test("requestDurationMs rounds elapsed request time to hundredths", () => {
  assert.equal(requestDurationMs(100, 101.234), 1.23);
  assert.equal(requestDurationMs(101, 100), 0);
});
