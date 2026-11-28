import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import serverModule from "../../apps/server/dist/http/server.js";
import { withBrowser } from "./chat-first-smoke.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const samples = Number(process.env.PERF_SAMPLES ?? 5);
assert.ok(Number.isInteger(samples) && samples >= 3, "PERF_SAMPLES must be an integer >= 3");
const home = await mkdtemp(resolve(os.tmpdir(), "conflux-browser-perf-"));
const results = [];
let server;
let chromiumVersion;
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
  };
};

function topologyFixture(topology, count) {
  const now = new Date().toISOString();
  const host = os.hostname();
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    name: `perf-${i}`,
    kind: "external",
    runtime: "codex",
    state: "idle",
    host,
    workdir: home,
    incoming_call_mode: "auto",
    external_session_id: null,
    project_id: null,
    project_name: null,
    worktree_branch: null,
    pending_approvals: 0,
    context_count: 0,
    room_ids: [],
    live: true,
  }));
  const pairs =
    topology === "dense"
      ? nodes.flatMap((_, i) => [1, 2, 5].map((offset) => [i, (i + offset) % count]))
      : Array.from({ length: topology === "disconnected" ? 0 : count - 1 }, (_, i) => [
          topology === "tree" ? Math.floor(i / 2) : i,
          i + 1,
        ]);
  const edges = pairs.map(([from, to], i) => ({
    id: i + 1,
    from: nodes[from].id,
    to: nodes[to].id,
    weight: 1,
    last_interact_at: now,
    last_message: "Synthetic call",
    last_message_id: i + 1,
    last_status: "pending",
    trace_id: null,
    hop_count: 1,
  }));
  const calls = edges.map((edge) => ({
    id: edge.last_message_id,
    edge_id: edge.id,
    from_session: edge.from,
    to_session: edge.to,
    question: edge.last_message,
    status: edge.last_status,
    created_at: now,
  }));
  return { graph: { nodes, edges }, calls };
}

try {
  // Ignore desktop server settings: the benchmark serves its own database and build.
  process.env.CONFLUX_HOST = "127.0.0.1";
  delete process.env.CONFLUX_PORT;
  process.env.CONFLUX_WEB_DIST = resolve(root, "apps/web/dist");
  server = await serverModule.startHttpServer({ host: "127.0.0.1", port: 0, overrideDataDir: home });
  const url = `http://127.0.0.1:${server.server.address().port}`;
  const rootResponse = await fetch(url);
  assert.equal(rootResponse.status, 200, "built Web UI must be served");
  await rootResponse.arrayBuffer();
  await withBrowser(() => chromium.launch({ headless: true }), async (browser) => {
    chromiumVersion = browser.version();
    for (const topology of ["chain", "tree", "disconnected", "dense"]) {
      for (const count of [25, 100, 300]) {
        const { graph, calls } = topologyFixture(topology, count);
        const runs = [];
        for (let run = 0; run <= samples; run++) {
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          try {
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
              if (message.type() === "error") errors.push(message.text());
            });
            // Serve the real app and its remaining endpoints. Inject a fixed-size topology
            // independently of the server's live-peer TTL and call-list pagination.
            await page.route("**/graph", (route) => route.fulfill({ json: graph }));
            await page.route("**/mesh/calls?*", (route) => {
              const status = new URL(route.request().url()).searchParams.get("status");
              return route.fulfill({ json: { calls: status === "history" ? [] : calls } });
            });
            await page.addInitScript(() => {
              window.__longTasks = [];
              new PerformanceObserver((list) =>
                window.__longTasks.push(...list.getEntries().map((entry) => entry.duration)),
              ).observe({ type: "longtask", buffered: true });
            });
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.getByTestId("rail-graph-btn").click();
            await page.waitForFunction(
              ({ nodes, edges }) => {
                const mesh = document.querySelector('[data-testid="live-mesh-graph"]');
                return (
                  mesh?.querySelectorAll('[data-testid^="mesh-node-"]').length === nodes &&
                  mesh.querySelectorAll('[data-testid^="mesh-edge-pill-"]').length === edges &&
                  mesh.querySelectorAll("svg > g").length === edges
                );
              },
              { nodes: count, edges: calls.length },
            );
            const renderedMs = await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
              return performance.now();
            });
            assert.deepEqual(errors, [], "browser runtime errors before scrolling");
            const scrollMs = await page.locator(".cfx-dot-grid").evaluate(async (canvas) => {
              const before = canvas.scrollTop;
              if (canvas.scrollHeight <= canvas.clientHeight) throw new Error("Mesh canvas cannot scroll");
              const start = performance.now();
              await new Promise((done, reject) => {
                const timeout = setTimeout(() => {
                  canvas.removeEventListener("scroll", changed);
                  reject(new Error("Scroll did not update the mesh viewport"));
                }, 5000);
                function changed() {
                  clearTimeout(timeout);
                  requestAnimationFrame(() => requestAnimationFrame(done));
                }
                canvas.addEventListener("scroll", changed, { once: true });
                canvas.scrollTop = before + 400;
              });
              if (canvas.scrollTop <= before) throw new Error("Mesh viewport did not advance");
              return performance.now() - start;
            });
            assert.deepEqual(errors, [], "browser runtime errors after scrolling");
            const longTasks = await page.evaluate(() => window.__longTasks);
            if (run > 0) runs.push({ renderedMs, scrollMs, longTasks });
          } finally {
            await context.close();
          }
        }
        const result = {
          topology,
          nodes: count,
          edges: calls.length,
          runs,
          renderMs: summary(runs.map((run) => run.renderedMs)),
          scrollMs: summary(runs.map((run) => run.scrollMs)),
          longTaskMaxMs: Math.max(0, ...runs.flatMap((run) => run.longTasks)),
        };
        results.push(result);
        console.log(
          `${topology} ${count}: render ${result.renderMs.median.toFixed(1)} ms; scroll ${result.scrollMs.median.toFixed(1)} ms; long-task max ${result.longTaskMaxMs.toFixed(1)} ms`,
        );
      }
    }
  });
  const report = {
    measuredAt: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version,
    chromium: chromiumVersion,
    os: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0].model,
    memoryBytes: os.totalmem(),
    viewport: { width: 1440, height: 900 },
    samples,
    results,
  };
  const output = resolve(root, "test-results/performance/browser.json");
  await mkdir(resolve(root, "test-results/performance"), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${output}`);
} finally {
  try {
    await server?.close();
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
