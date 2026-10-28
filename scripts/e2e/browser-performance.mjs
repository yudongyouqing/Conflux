import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = resolve(root, "apps/web/dist");
const samples = Number(process.env.PERF_SAMPLES ?? 5);
assert.ok(Number.isInteger(samples) && samples >= 3, "PERF_SAMPLES must be an integer >= 3");
await readFile(resolve(dist, "index.html"));
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    assert.ok(file.startsWith(dist + "/") || file.startsWith(dist + "\\"));
    const body = await readFile(file);
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
      }[extname(file)] ?? "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median:
      sorted.length % 2
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    max: sorted.at(-1),
  };
};
try {
  browser = await chromium.launch({ headless: true });
  for (const topology of ["chain", "tree", "disconnected"]) {
    for (const count of [25, 100, 300]) {
      const graph = {
        nodes: Array.from({ length: count }, (_, i) => ({
          id: `n${i}`,
          name: `perf-${i}`,
          type: "session",
          status: "active",
          context_count: 0,
          pending_inbox: 0,
        })),
        edges: Array.from({ length: topology === "disconnected" ? 0 : count - 1 }, (_, i) => ({
          id: i + 1,
          from: `n${topology === "tree" ? Math.floor(i / 2) : i}`,
          to: `n${i + 1}`,
          weight: 1,
          last_message: null,
        })),
      };
      const runs = [];
      for (let run = 0; run <= samples; run++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error" && !message.text().includes("frame-ancestors"))
              errors.push(message.text());
          });
          await page.route(
            /\/(graph|sessions|messages|agents|runtimes|settings|healthz|chat-rooms|web|conversations|context)(\?|\/|$)/,
            async (route) => {
              const path = new URL(route.request().url()).pathname;
              await route.fulfill({
                json:
                  path === "/graph"
                    ? graph
                    : path === "/healthz"
                      ? { ok: true }
                      : path === "/settings/terminal"
                        ? { terminal: "system", options: [] }
                        : path === "/settings"
                          ? { providers: {} }
                          : path === "/runtimes"
                            ? { runtimes: {}, agents: [] }
                            : path === "/chat-rooms"
                              ? { rooms: [] }
                              : path === "/agents"
                                ? { agents: [] }
                                : path === "/sessions"
                                  ? { sessions: graph.nodes }
                                  : path.startsWith("/messages")
                                    ? { messages: [] }
                                    : {},
              });
            },
          );
          await page.addInitScript(() => {
            window.__longTasks = [];
            new PerformanceObserver((list) =>
              window.__longTasks.push(...list.getEntries().map((e) => e.duration)),
            ).observe({ type: "longtask", buffered: true });
          });
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page
            .waitForFunction(
              ({ nodes, edges }) =>
                document.querySelectorAll(".react-flow__node").length === nodes &&
                document.querySelectorAll(".react-flow__edge").length === edges,
              { nodes: count, edges: graph.edges.length },
            )
            .catch(async (error) => {
              console.error(errors, (await page.locator("body").innerText()).slice(0, 1800));
              throw error;
            });
          const renderedMs = await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
            return performance.now();
          });
          // Allow the initial fit-view animation to finish before zooming.
          await page.waitForTimeout(1000);
          assert.deepEqual(errors, [], "browser runtime errors before zoom");
          const zoomMs = await page.evaluate(async () => {
            const viewport = document.querySelector(".react-flow__viewport");
            const before = viewport.style.transform;
            const button = document.querySelector(".react-flow__controls-zoomin");
            if (!button || button.disabled) throw new Error("Zoom control unavailable");
            const start = performance.now();
            await new Promise((done, reject) => {
              const timeout = setTimeout(() => {
                observer.disconnect();
                reject(new Error("Zoom did not update viewport"));
              }, 5000);
              const observer = new MutationObserver(() => {
                if (viewport.style.transform === before) return;
                observer.disconnect();
                clearTimeout(timeout);
                requestAnimationFrame(() => requestAnimationFrame(done));
              });
              observer.observe(viewport, { attributes: true, attributeFilter: ["style"] });
              button.click();
            });
            return performance.now() - start;
          });
          assert.deepEqual(errors, [], "browser runtime errors");
          const longTasks = await page.evaluate(() => window.__longTasks);
          if (run > 0) runs.push({ renderedMs, zoomMs, longTasks });
        } finally {
          await context.close();
        }
      }
      const result = {
        topology,
        nodes: count,
        edges: graph.edges.length,
        runs,
        renderMs: summary(runs.map((r) => r.renderedMs)),
        zoomMs: summary(runs.map((r) => r.zoomMs)),
        longTaskMaxMs: Math.max(0, ...runs.flatMap((r) => r.longTasks)),
      };
      results.push(result);
      console.log(
        `${topology} ${count}: render ${result.renderMs.median.toFixed(1)} ms; zoom ${result.zoomMs.median.toFixed(1)} ms; long-task max ${result.longTaskMaxMs.toFixed(1)} ms`,
      );
    }
  }
  const report = {
    measuredAt: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version,
    chromium: browser.version(),
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
  await browser?.close();
  await new Promise((done) => server.close(done));
}
