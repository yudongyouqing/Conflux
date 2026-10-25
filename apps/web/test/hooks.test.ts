import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { createElement, type ReactNode } from "react";
import { useGraph, useMessages } from "../src/hooks.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const { cleanup, renderHook, waitFor } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

after(() => dom.window.close());

function setupHook<T>(callback: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const rendered = renderHook(callback, { wrapper });
  return { ...rendered, queryClient };
}

test("useGraph loads all graph data and configures five-second polling", async () => {
  const graph = { nodes: [], edges: [] };
  let requestedUrl = "";
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return Response.json(graph);
  });
  const { result, queryClient } = setupHook(() => useGraph());

  await waitFor(() => assert.deepEqual(result.current.data, graph));

  const query = queryClient.getQueryCache().getAll()[0];
  assert.equal(requestedUrl, "/graph?status=all");
  assert.deepEqual(query.queryKey, ["graph"]);
  assert.equal(query.options.refetchInterval, 5000);
});

test("useMessages checks inbox before requesting filtered messages", async () => {
  const requests: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json(requests.length === 1 ? { messages: [] } : { messages: [{ id: 9 }] });
  });
  const { result, queryClient } = setupHook(() => useMessages({ status: "pending", limit: 25 }));

  await waitFor(() => assert.deepEqual(result.current.data?.messages, [{ id: 9 }]));

  assert.deepEqual(requests, ["/messages/inbox", "/messages?status=pending&limit=25"]);
  assert.deepEqual(queryClient.getQueryCache().getAll()[0].queryKey, [
    "messages",
    { status: "pending", limit: 25 },
  ]);
});

test("useMessages continues loading messages when inbox preflight fails", async () => {
  const requests: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    if (requests.length === 1) return new Response("not registered", { status: 404 });
    return Response.json({ messages: [{ id: 10 }] });
  });
  const { result } = setupHook(() => useMessages());

  await waitFor(() => assert.deepEqual(result.current.data?.messages, [{ id: 10 }]));

  assert.deepEqual(requests, ["/messages/inbox", "/messages?status=all&limit=100"]);
});
