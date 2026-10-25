import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { api } from "../src/api.ts";

afterEach(() => mock.restoreAll());

test("getMessages encodes filters and omits unset values", async () => {
  let requestedUrl = "";
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return Response.json({ messages: [] });
  });

  await api.getMessages({ from: "agent/a", status: "pending", limit: 25 });

  assert.equal(requestedUrl, "/messages?from=agent%2Fa&status=pending&limit=25");
});

test("createRuntimeAgent posts JSON to the runtime collection", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), init };
    return Response.json({ agent: { id: 7 } });
  });
  const body = { name: "worker", runtime: "codex", workdir: "C:/repo" };

  await api.createRuntimeAgent(body);

  assert.equal(request?.url, "/runtimes");
  assert.equal(request?.init?.method, "POST");
  assert.equal(new Headers(request?.init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), body);
});

test("saveTerminalSettings uses PUT and dataClear uses POST", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return Response.json({});
  });

  await api.saveTerminalSettings({ auto_wake: true });
  await api.dataClear({ messages: true });

  assert.deepEqual(requests, [
    { url: "/settings/terminal", method: "PUT" },
    { url: "/data/clear", method: "POST" },
  ]);
});

test("deleteRuntimeAgent encodes the identifier and sends DELETE", async () => {
  let request: { url: string; method?: string } | undefined;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), method: init?.method };
    return Response.json({ ok: true });
  });

  await api.deleteRuntimeAgent(42);

  assert.deepEqual(request, { url: "/runtimes/42", method: "DELETE" });
});

test("HTTP errors include response text and status", async () => {
  mock.method(globalThis, "fetch", async () => new Response("agent missing", { status: 404 }));

  await assert.rejects(api.getGraph(), { message: "HTTP 404: agent missing" });
});
