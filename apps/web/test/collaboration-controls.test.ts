import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { Message } from "@conflux/shared";
import { MessageCard } from "../src/components/MessageCard.tsx";
import { RuntimesTab } from "../src/components/RuntimesTab.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { cleanup, render, fireEvent, waitFor } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  mock.restoreAll();
});
after(() => dom.window.close());

function setup(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return { ...render(createElement(QueryClientProvider, { client }, node)), client };
}

const message: Message = {
  id: 17,
  from_session: "web-console",
  to_session: "worker",
  question: "Please inspect",
  reply: null,
  status: "pending",
  created_at: "2026-10-30T01:00:00Z",
  replied_at: null,
  delivery: {
    state: "woken",
    attempts: 2,
    last_attempted_at: "2026-10-30T01:01:00Z",
    reason: null,
  },
};

test("pending cards show a wake attempt separately from read state and retry the existing message", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let openCount = 0;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json({ message, wake: { woken: true } });
  });
  const view = setup(
    createElement(MessageCard, {
      msg: message,
      selected: false,
      onClick: () => {
        openCount++;
      },
    }),
  );
  assert.match(view.container.textContent ?? "", /已尝试唤醒/);
  assert.doesNotMatch(view.container.textContent ?? "", /已送达|已收到/);
  fireEvent.click(view.getByRole("button", { name: "重试唤醒" }));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.equal(requests[0].url, "/messages/17/retry");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(new Headers(requests[0].init?.headers).get("X-Session-Id"), "web-console");
  assert.equal(openCount, 0);
});

test("seen cards preserve read status and never offer retry", () => {
  const view = setup(
    createElement(MessageCard, {
      msg: { ...message, status: "seen" },
      selected: false,
      toStatus: "ended",
      onClick: () => {},
    }),
  );
  assert.equal(view.queryByRole("button", { name: "重试唤醒" }), null);
  assert.match(view.container.textContent ?? "", /seen/);
  assert.doesNotMatch(view.container.textContent ?? "", /未送达/);
});

test("legacy pending cards can retry and queued or failed attempts use accurate labels", () => {
  const props = { selected: false, onClick: () => {} };
  const view = setup(
    createElement(MessageCard, { ...props, msg: { ...message, delivery: undefined } }),
  );
  assert.ok(view.getByRole("button", { name: "重试唤醒" }));
  view.rerender(
    createElement(
      QueryClientProvider,
      { client: view.client },
      createElement(MessageCard, {
        ...props,
        msg: { ...message, delivery: { ...message.delivery!, state: "queued" } },
      }),
    ),
  );
  assert.match(view.container.textContent ?? "", /等待唤醒/);
  view.rerender(
    createElement(
      QueryClientProvider,
      { client: view.client },
      createElement(MessageCard, {
        ...props,
        msg: {
          ...message,
          delivery: { ...message.delivery!, state: "failed", reason: "No live process" },
        },
      }),
    ),
  );
  assert.match(view.container.textContent ?? "", /唤醒失败/);
  assert.match(view.container.textContent ?? "", /No live process/);
});

test("retry reports loading and server errors while preserving the message", async () => {
  let finish!: (response: Response) => void;
  mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const view = setup(
    createElement(MessageCard, { msg: message, selected: false, onClick: () => {} }),
  );
  fireEvent.click(view.getByRole("button", { name: "重试唤醒" }));
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "正在重试…" }) as HTMLButtonElement).disabled,
      true,
    ),
  );
  finish(new Response("session cannot be resumed", { status: 409 }));
  await waitFor(() =>
    assert.match(view.getByRole("alert").textContent ?? "", /session cannot be resumed/),
  );
  assert.match(view.container.textContent ?? "", /Please inspect/);
});

test("fresh delivery updates replace an earlier local retry result", async () => {
  mock.method(globalThis, "fetch", async () =>
    Response.json({
      message: { ...message, delivery: { ...message.delivery!, attempts: 3 } },
      wake: { woken: true },
    }),
  );
  const props = { selected: false, onClick: () => {} };
  const view = setup(createElement(MessageCard, { ...props, msg: message }));
  fireEvent.click(view.getByRole("button", { name: "重试唤醒" }));
  await waitFor(() => assert.match(view.container.textContent ?? "", /尝试 3 次/));
  view.rerender(
    createElement(
      QueryClientProvider,
      { client: view.client },
      createElement(MessageCard, {
        ...props,
        msg: { ...message, delivery: { ...message.delivery!, attempts: 4, state: "failed" } },
      }),
    ),
  );
  assert.match(view.container.textContent ?? "", /尝试 4 次/);
  assert.match(view.container.textContent ?? "", /唤醒失败/);
});

const instance = {
  id: "run-7",
  preset_id: 7,
  preset_name: "Reviewer",
  runtime: "codex",
  workdir: "C:/repo",
  session_id: "session-7",
  runtime_pid: 321,
  state: "running",
  created_at: "2026-10-30T01:00:00Z",
  updated_at: "2026-10-30T01:01:00Z",
  last_seen: "2026-10-30T01:01:00Z",
  error: null,
  ended_at: null,
  resumed_from: null,
  can_stop: false,
  can_resume: false,
  limitation: "Process identity cannot be verified",
};

test("runtime instances show verified capability and keep unsafe stop disabled", async () => {
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) === "/runtime-instances") return Response.json({ instances: [instance] });
    return Response.json({ agents: [], runtimes: {} });
  });
  const view = setup(createElement(RuntimesTab));
  await waitFor(() => assert.ok(view.queryByText("Reviewer")));
  assert.match(view.container.textContent ?? "", /运行实例/);
  assert.match(view.container.textContent ?? "", /321/);
  assert.match(view.container.textContent ?? "", /session-7/);
  assert.match(view.container.textContent ?? "", /Process identity cannot be verified/);
  assert.equal(
    (view.getByRole("button", { name: "停止实例" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("resuming an ended instance uses its resume endpoint and refreshes the list", async () => {
  const requests: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/runtime-instances")
      return Response.json({ instances: [{ ...instance, state: "ended", can_resume: true }] });
    if (url.endsWith("/resume"))
      return Response.json({
        started: true,
        instance: { ...instance, id: "run-8", resumed_from: "run-7" },
      });
    return Response.json({ agents: [], runtimes: {} });
  });
  const view = setup(createElement(RuntimesTab));
  await waitFor(() => assert.ok(view.queryByRole("button", { name: "恢复为新实例" })));
  fireEvent.click(view.getByRole("button", { name: "恢复为新实例" }));
  await waitFor(() => assert.ok(requests.includes("POST /runtime-instances/run-7/resume")));
  await waitFor(() =>
    assert.equal(requests.filter((r) => r === "GET /runtime-instances").length, 2),
  );
});

test("verified stop reports an operation error and clears its loading state", async () => {
  let finish!: (response: Response) => void;
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/runtime-instances")
      return Response.json({ instances: [{ ...instance, can_stop: true, limitation: null }] });
    if (url.endsWith("/stop"))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Response.json({ agents: [], runtimes: {} });
  });
  const view = setup(createElement(RuntimesTab));
  await waitFor(() => assert.ok(view.queryByRole("button", { name: "停止实例" })));
  fireEvent.click(view.getByRole("button", { name: "停止实例" }));
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "正在停止…" }) as HTMLButtonElement).disabled,
      true,
    ),
  );
  finish(new Response("identity changed", { status: 409 }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent ?? "", /identity changed/));
  assert.equal(
    (view.getByRole("button", { name: "停止实例" }) as HTMLButtonElement).disabled,
    false,
  );
});

test("failed instance shows launch error and refuses an unavailable resume", async () => {
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) === "/runtime-instances")
      return Response.json({
        instances: [
          { ...instance, state: "failed", error: "CLI executable missing", runtime_pid: null },
        ],
      });
    return Response.json({ agents: [], runtimes: {} });
  });
  const view = setup(createElement(RuntimesTab));
  await waitFor(() => assert.ok(view.queryByText("CLI executable missing")));
  assert.equal(
    (view.getByRole("button", { name: "恢复为新实例" }) as HTMLButtonElement).disabled,
    true,
  );
  assert.match(view.container.textContent ?? "", /未绑定/);
});
