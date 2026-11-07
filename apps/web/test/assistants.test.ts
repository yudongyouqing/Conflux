import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import type { Agent, GraphNode, RuntimeAgent, RuntimeInstance } from "@conflux/shared";
import { buildAssistantCatalog } from "../src/assistant-catalog.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  mock.restoreAll();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

// ---- fixtures --------------------------------------------------------------

function preset(over: Partial<RuntimeAgent> & Pick<RuntimeAgent, "id" | "name">): RuntimeAgent {
  return {
    runtime: "claude",
    workdir: null,
    model: null,
    base_url: null,
    api_key: null,
    extra_env: null,
    instructions: null,
    interval_min: null,
    last_scheduled_run: null,
    ...over,
  };
}

function instance(
  over: Partial<RuntimeInstance> & Pick<RuntimeInstance, "id" | "preset_id">,
): RuntimeInstance {
  return {
    preset_name: "preset",
    runtime: "claude",
    workdir: null,
    session_id: null,
    runtime_pid: null,
    state: "running",
    created_at: "2026-11-07T00:00:00Z",
    updated_at: "2026-11-07T00:00:00Z",
    last_seen: "2026-11-07T00:00:00Z",
    error: null,
    ended_at: null,
    resumed_from: null,
    can_stop: false,
    can_resume: false,
    limitation: null,
    ...over,
  };
}

function modelAgent(over: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    system_prompt: "sp",
    model_config: { provider: "anthropic", model: "m" },
    description: null,
    created_at: "2026-11-07T00:00:00Z",
    updated_at: "2026-11-07T00:00:00Z",
    ...over,
  };
}

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    name: id,
    status: "active",
    type: "session",
    context_count: 0,
    pending_inbox: 0,
    ...over,
    id,
  };
}

// ---- buildAssistantCatalog: identity-only association ----------------------

test("same-id different-kind objects never mix; keys are type-prefixed", () => {
  const catalog = buildAssistantCatalog(
    [modelAgent({ id: 1, name: "同名助手" })],
    [preset({ id: 1, name: "同名助手" })],
    [],
    [],
  );
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.coding.length, 1);
  assert.equal(catalog.models[0].key, "model:1");
  assert.equal(catalog.coding[0].key, "coding:1");
  assert.notEqual(catalog.models[0].key, catalog.coding[0].key);
});

test("instances join their preset by preset_id; same preset keeps every instance", () => {
  const catalog = buildAssistantCatalog(
    [],
    [preset({ id: 7, name: "审查" })],
    [
      instance({ id: "run-a", preset_id: 7 }),
      instance({ id: "run-b", preset_id: 7, state: "ended" }),
      instance({ id: "run-c", preset_id: 9 }),
    ],
    [],
  );
  assert.deepEqual(
    catalog.coding[0].instances.map((i) => i.id).sort(),
    ["run-a", "run-b"],
  );
  // an instance whose preset is gone lands in the orphan section instead
  assert.deepEqual(catalog.orphanInstances.map((i) => i.id), ["run-c"]);
});

test("sessions attach by instance session_id first, then node agent_id, deduped by id", () => {
  const catalog = buildAssistantCatalog(
    [],
    [
      preset({ id: 7, name: "A" }),
      preset({ id: 8, name: "B" }),
    ],
    [instance({ id: "run-1", preset_id: 7, session_id: "s-via-instance" })],
    [
      node("s-via-instance", { name: "实例绑定的会话", agent_id: 8 }),
      node("s-via-agent", { name: "配置派生的会话", agent_id: 7 }),
      node("s-free", { name: "无关会话" }),
    ],
  );
  const presetA = catalog.coding.find((c) => c.preset.id === 7)!;
  const presetB = catalog.coding.find((c) => c.preset.id === 8)!;
  // the instance binding wins over the node's agent_id derivation, and the
  // same session never appears under two presets
  assert.deepEqual(
    presetA.sessions.map((s) => s.id),
    ["s-via-instance", "s-via-agent"],
  );
  assert.deepEqual(presetB.sessions, [], "deduped away from the second preset");
});

test("a session without any preset binding invents nothing", () => {
  const catalog = buildAssistantCatalog([], [], [], [node("s1", { agent_id: 42 })]);
  assert.deepEqual(catalog.coding, []);
  assert.deepEqual(catalog.orphanInstances, []);
});

test("preset.live is never trusted: running counts derive from instances", () => {
  const catalog = buildAssistantCatalog(
    [],
    [preset({ id: 7, name: "虚标在线", live: true })],
    [instance({ id: "run-x", preset_id: 7, state: "ended" })],
    [],
  );
  const item = catalog.coding[0];
  const running = item.instances.filter((i) => i.state === "running").length;
  assert.equal(running, 0, "ended instances must not count as running");
  assert.equal(item.preset.live, true, "raw field passes through; consumers use derived counts");
});

test("identical display names across kinds and presets stay separate items", () => {
  const catalog = buildAssistantCatalog(
    [modelAgent({ id: 3, name: "重名" })],
    [preset({ id: 5, name: "重名" }), preset({ id: 6, name: "重名" })],
    [],
    [],
  );
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.coding.length, 2);
});

// ---- AssistantsTab mount behavior ------------------------------------------

const { render, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const React = await import("react");
const { createElement } = React;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AssistantsTab } = await import("../src/components/AssistantsTab.tsx");

interface AssistantsState {
  presets: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  instances: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
  calls: Array<{ url: string; method: string; body?: unknown }>;
}

function mountAssistants(state: AssistantsState) {
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ url, method, body });
      if (url === "/runtimes" && method === "POST")
        return Response.json({ agent: state.presets[0] });
      if (url === "/agents" && method === "POST") return Response.json({ agent: state.agents[0] });
      if (url === "/runtimes")
        return Response.json({
          runtimes: { claude: { label: "Claude Code", executable: "claude", executableEnv: "" } },
          agents: state.presets,
        });
      if (url === "/agents") return Response.json({ agents: state.agents });
      if (url === "/runtime-instances") return Response.json({ instances: state.instances });
      if (url === "/graph?status=all") return Response.json({ nodes: state.nodes, edges: [] });
      return Response.json({});
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const view = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AssistantsTab, { active: true, onOpenSession: () => {} }),
    ),
  );
  return { ...view, client, state };
}

test("the assistants page defaults to the coding category with a single create entry", async () => {
  const view = mountAssistants({ presets: [], agents: [], instances: [], nodes: [], calls: [] });
  await waitFor(() => assert.ok(view.getByText("助手")));
  assert.equal(
    view.getByRole("button", { name: "编码助手" }).getAttribute("aria-pressed"),
    "true",
  );
  assert.ok(view.getByRole("button", { name: "模型助手" }));
  assert.ok(view.getByRole("button", { name: "创建编码助手" }));
  await waitFor(() => assert.match(view.container.textContent ?? "", /还没有编码助手预设/));
});

test("creating from the current category skips the chooser and locates the new preset", async () => {
  const state: AssistantsState = {
    presets: [{ id: 12, name: "新编码助手", runtime: "claude", workdir: null }],
    agents: [],
    instances: [],
    nodes: [],
    calls: [],
  };
  const view = mountAssistants(state);
  await waitFor(() => assert.ok(view.getByRole("button", { name: "创建编码助手" })));

  fireEvent.click(view.getByRole("button", { name: "创建编码助手" }));
  const dialog = await view.findByRole("dialog");
  // no type chooser — the runtime form is shown directly for the coding page
  await waitFor(() => assert.ok(within(dialog).getByText("运行时 *")));
  assert.equal(within(dialog).queryByText("模型智能体"), null);

  fireEvent.change(within(dialog).getByPlaceholderText("e.g. api-worker"), {
    target: { value: "新编码助手" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建", exact: true }));
  const created = await waitFor(() => {
    const call = state.calls.find((c) => c.url === "/runtimes" && c.method === "POST");
    assert.ok(call);
    return call;
  });
  assert.equal((created.body as { name: string }).name, "新编码助手");
  // the new preset is located (card expanded with its instance section)
  await waitFor(() => assert.match(view.container.textContent ?? "", /还没有运行实例/));
});

test("model creation lands in the model chat; the list marks separate conversations", async () => {
  const state: AssistantsState = {
    presets: [],
    agents: [
      {
        id: 5,
        name: "总结员",
        system_prompt: "sp",
        model_config: { provider: "anthropic", model: "m" },
        description: null,
        created_at: "2026-11-07T00:00:00Z",
        updated_at: "2026-11-07T00:00:00Z",
      },
    ],
    instances: [],
    nodes: [],
    calls: [],
  };
  const view = mountAssistants(state);
  await waitFor(() => assert.ok(view.getByRole("button", { name: "模型助手" })));

  fireEvent.click(view.getByRole("button", { name: "模型助手" }));
  await waitFor(() =>
    assert.equal(
      view.getByRole("button", { name: "模型助手" }).getAttribute("aria-pressed"),
      "true",
    ),
  );
  assert.ok(view.getByText("总结员"));
  // separate conversations are labeled; joining a room is not offered
  assert.ok(view.getByText("独立对话"));
  assert.equal(view.queryByRole("button", { name: /加入聊天室/ }), null);

  fireEvent.click(view.getByRole("button", { name: "创建模型助手" }));
  const dialog = await view.findByRole("dialog");
  // the model form is shown directly (its name field is a placeholder input)
  await waitFor(() => assert.ok(within(dialog).getByPlaceholderText("名称 *")));
  fireEvent.change(within(dialog).getByPlaceholderText("名称 *"), {
    target: { value: "总结员" },
  });
  fireEvent.change(within(dialog).getByPlaceholderText(/模型 \*/), { target: { value: "m" } });
  fireEvent.change(within(dialog).getByPlaceholderText("System Prompt *"), {
    target: { value: "sp" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建", exact: true }));
  const created = await waitFor(() => {
    const call = state.calls.find((c) => c.url === "/agents" && c.method === "POST");
    assert.ok(call);
    return call;
  });
  assert.equal((created.body as { name: string }).name, "总结员");
  // a typed model creation opens the assistant's own chat directly
  await waitFor(() => assert.ok(view.getByText("返回")));
});

test("a coding preset shows every instance it owns, keyed by identity", async () => {
  const state: AssistantsState = {
    presets: [{ id: 7, name: "审查", runtime: "codex", workdir: "C:/repo" }],
    agents: [],
    instances: [
      { id: "run-a", preset_id: 7, preset_name: "审查", state: "running", can_stop: false, can_resume: false, limitation: null, session_id: "s-a", runtime: "codex", workdir: null, runtime_pid: 1, created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:00Z", last_seen: null, error: null, ended_at: null, resumed_from: null },
      { id: "run-b", preset_id: 7, preset_name: "审查", state: "ended", can_stop: false, can_resume: false, limitation: null, session_id: null, runtime: "codex", workdir: null, runtime_pid: null, created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:00Z", last_seen: null, error: null, ended_at: null, resumed_from: null },
    ],
    nodes: [
      { id: "s-a", name: "实例会话", status: "active", type: "session", context_count: 0, pending_inbox: 0 },
    ],
    calls: [],
  };
  const view = mountAssistants(state);
  await waitFor(() => assert.ok(view.getByText("审查")));
  // identity-sourced stats before expanding
  assert.match(view.container.textContent ?? "", /运行中 1 个实例/);
  assert.match(view.container.textContent ?? "", /关联 1 个会话/);

  fireEvent.click(view.getByText("审查"));
  // the row prints "runtime / id" — match by fragment
  await waitFor(() => assert.ok(view.getByText(/run-a/)));
  assert.ok(view.getByText(/run-b/));
  // only the instance with a REAL session id offers a conversation entry
  assert.ok(view.getByText("实例会话"));
  assert.equal(view.container.querySelectorAll("article").length, 2);
});

// ---- review regressions: PTY init race + hidden-page query gating ----------

// jsdom lacks scrollIntoView (PtyPanel auto-scroll); a no-op is enough
if (!dom.window.HTMLElement.prototype.scrollIntoView) {
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
}

const { PtyPanel } = await import("../src/components/PtyPanel.tsx");
const { RuntimeInstancesPanel } = await import("../src/components/RuntimeInstancesPanel.tsx");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function withPtyFake(fake: {
  getBuffer: (id: number) => Promise<{ buffer: string | null }>;
  isAlive: (id: number) => Promise<boolean>;
  onOutput: (id: number, cb: (chunk: string) => void) => () => void;
}) {
  const prior = (globalThis as Record<string, unknown>).confluxPty;
  (globalThis as Record<string, unknown>).confluxPty = {
    ...fake,
    inject: async () => ({ ok: true }),
  };
  return () => {
    if (prior === undefined) delete (globalThis as Record<string, unknown>).confluxPty;
    else (globalThis as Record<string, unknown>).confluxPty = prior;
  };
}

function mountPty(active: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PtyPanel, { agentId: 3, agentName: "审查", active }),
    ),
  );
  return { ...view, client };
}

test("hiding the PTY during getBuffer cancels init: no late subscription", async () => {
  const ops: string[] = [];
  const gate = deferred<{ buffer: string | null }>();
  const restore = withPtyFake({
    getBuffer: () => gate.promise,
    isAlive: async () => true,
    onOutput: () => {
      ops.push("subscribe");
      return () => ops.push("dispose");
    },
  });
  try {
    const view = mountPty(true);
    // hide while getBuffer is still pending — cleanup runs before unsub exists
    view.rerender(
      createElement(
        QueryClientProvider,
        { client: view.client },
        createElement(PtyPanel, { agentId: 3, agentName: "审查", active: false }),
      ),
    );
    await act(async () => {
      gate.resolve({ buffer: "stale" });
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.deepEqual(ops, [], "a cancelled init must never subscribe to output");
  } finally {
    restore();
  }
});

test("hiding the PTY between isAlive and onOutput cancels init too", async () => {
  const ops: string[] = [];
  const bufferGate = deferred<{ buffer: string | null }>();
  const aliveGate = deferred<boolean>();
  const restore = withPtyFake({
    getBuffer: () => bufferGate.promise,
    isAlive: () => aliveGate.promise,
    onOutput: () => {
      ops.push("subscribe");
      return () => ops.push("dispose");
    },
  });
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PtyPanel, { agentId: 3, agentName: "审查", active: true }),
      ),
    );
    await act(async () => {
      bufferGate.resolve({ buffer: "" });
      await new Promise((r) => setTimeout(r, 0));
    });
    // isAlive is pending now; hide the page, then let isAlive resolve
    view.rerender(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PtyPanel, { agentId: 3, agentName: "审查", active: false }),
      ),
    );
    await act(async () => {
      aliveGate.resolve(true);
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.deepEqual(ops, [], "no subscription may appear after the effect was cleaned up");
  } finally {
    restore();
  }
});

test("a hidden assistants page stops polling its own queries", async () => {
  const state: AssistantsState = {
    presets: [{ id: 7, name: "审查", runtime: "claude", workdir: null }],
    agents: [],
    instances: [],
    nodes: [],
    calls: [],
  };
  const view = mountAssistants(state);
  await waitFor(() => assert.ok(view.getByText("审查")));

  const count = (prefix: string) => state.calls.filter((c) => c.url === prefix).length;
  const before = {
    agents: count("/agents"),
    runtimes: count("/runtimes"),
    instances: count("/runtime-instances"),
  };
  assert.ok(before.runtimes > 0, "fixture sanity: queries ran while visible");

  view.rerender(
    createElement(
      QueryClientProvider,
      { client: view.client },
      createElement(AssistantsTab, { active: false, onOpenSession: () => {} }),
    ),
  );
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["agents"] });
    await view.client.invalidateQueries({ queryKey: ["runtimes"] });
    await view.client.invalidateQueries({ queryKey: ["runtime-instances"] });
    await new Promise((r) => setTimeout(r, 50));
  });
  assert.equal(count("/agents"), before.agents, "hidden agents query stays silent");
  assert.equal(count("/runtimes"), before.runtimes, "hidden runtimes query stays silent");
  assert.equal(
    count("/runtime-instances"),
    before.instances,
    "hidden instances query stays silent",
  );
});

test("a controlled instances panel does not start its own query", async () => {
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ instances: [] });
  });
  const orphan = {
    id: "run-orphan",
    preset_id: 99,
    preset_name: "已删预设",
    runtime: "codex",
    workdir: null,
    session_id: null,
    runtime_pid: null,
    state: "ended",
    created_at: "2026-11-07T00:00:00Z",
    updated_at: "2026-11-07T00:00:00Z",
    last_seen: null,
    error: null,
    ended_at: null,
    resumed_from: null,
    can_stop: false,
    can_resume: false,
    limitation: null,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RuntimeInstancesPanel, {
        instances: [orphan as never],
        title: "无关联配置的运行记录",
        active: true,
      }),
    ),
  );
  await waitFor(() => assert.ok(document.body.textContent?.includes("run-orphan")));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    calls.some((c) => c === "/runtime-instances"),
    false,
    "a controlled panel renders the given set without querying",
  );
});
