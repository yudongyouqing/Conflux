/**
 * Chat-first workspace smoke (P1): boots an isolated server + vite against a
 * temp CONFLUX_HOME, seeds controlled fake sessions with auto-wake disabled,
 * then drives the real UI through room lifecycle, directed/broadcast sends
 * and a peer conversation. Sends go through the real API; the fake sessions
 * are data fixtures only, never real Codex/Claude hosts.
 *
 * Usage: node scripts/e2e/chat-first-smoke.mjs
 * (requires `npm run build -w packages/shared` once per checkout)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VITE_BIN = resolve(ROOT, "node_modules/vite/bin/vite.js");
const ARTIFACTS = join(ROOT, "test-results", "e2e", "chat-first");

// fixed ports, checked before use — never the production 9527
const PORT_CANDIDATES = [19527, 19529];
const WEB_PORT_CANDIDATES = [5199, 5201];

function portFree(port) {
  return new Promise((yes) => {
    const probe = createServer();
    probe.once("error", () => yes(false));
    probe.once("listening", () => probe.close(() => yes(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function pickPort(candidates, label) {
  for (const port of candidates) {
    if (await portFree(port)) return port;
  }
  throw new Error(`${label}: no free port among ${candidates.join(", ")}`);
}

const SERVER_PORT = await pickPort(PORT_CANDIDATES, "server");
const WEB_PORT = await pickPort(WEB_PORT_CANDIDATES, "vite");
const API = `http://127.0.0.1:${SERVER_PORT}`;

const home = mkdtempSync(join(tmpdir(), "conflux-chat-first-"));
mkdirSync(ARTIFACTS, { recursive: true });

const server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts", "serve"], {
  cwd: ROOT,
  env: { ...process.env, CONFLUX_HOME: home, CONFLUX_PORT: String(SERVER_PORT) },
  stdio: ["ignore", "ignore", "pipe"],
});
const web = spawn(
  process.execPath,
  [VITE_BIN, "--port", String(WEB_PORT), "--strictPort", "--host", "127.0.0.1"],
  {
    cwd: join(ROOT, "apps/web"),
    env: { ...process.env, VITE_API_TARGET: API },
    stdio: ["ignore", "ignore", "pipe"],
  },
);

const childLogs = { server: "", web: "" };
for (const [name, child] of [
  ["server", server],
  ["web", web],
]) {
  child.stderr.on("data", (chunk) => {
    childLogs[name] = (childLogs[name] + chunk.toString()).slice(-8000);
  });
}

function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* child may still be starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function apiGet(path) {
  const res = await fetch(API + path);
  assert.equal(res.ok, true, `GET ${path} -> ${res.status}`);
  return res.json();
}

const passed = [];
function ok(name) {
  passed.push(name);
  console.log(`  ✓ ${name}`);
}

try {
  await Promise.all([waitFor(`${API}/healthz`), waitFor(`http://127.0.0.1:${WEB_PORT}/`)]);
  // controlled fake sessions; --controls also disables auto-wake
  spawnSync(process.execPath, ["--import", "tsx", "scripts/capture/seed-core.ts", home, "--controls", "--chat-first"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const outbound = [];
  page.on("request", (request) => outbound.push(request.url()));

  // ---- 1. cold start: chat workspace with the empty guide ---------------
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await page.getByRole("button", { name: "创建聊天室" }).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(ARTIFACTS, "guide-1440.png"), fullPage: true });
  ok("cold start lands on chat with the empty guide");

  // ---- 2. create an empty room through the wizard ------------------------
  await page.getByRole("button", { name: "创建聊天室" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder(/聊天室名称/).fill("P1 验收房");
  await dialog.getByRole("button", { name: "创建空聊天室" }).click();
  await page.getByRole("heading", { name: "P1 验收房" }).waitFor();
  let rooms = (await apiGet("/chat-rooms")).rooms;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].name, "P1 验收房");
  assert.deepEqual(rooms[0].members, []);
  await page.getByRole("button", { name: "添加成员" }).first().waitFor();
  ok("empty room created via UI and confirmed against the API");

  // ---- 3. add a member from the details rail -----------------------------
  // the member is the runtime-less fake session: its wake strategy refuses
  // before spawning anything, keeping the verification offline-safe
  const detailsToggle = page.getByRole("button", { name: "详情", exact: true });
  const details = page.locator(".workspace-details");
  if (!(await details.isVisible())) await detailsToggle.click();
  await details.getByRole("button", { name: "添加成员" }).click();
  await details.getByRole("button", { name: "验收会话" }).click();
  await details.getByText(/1 成员/).waitFor();
  rooms = (await apiGet("/chat-rooms")).rooms;
  assert.deepEqual(rooms[0].members, ["cap-chat-first"]);
  ok("member added from details and confirmed against the API");

  // ---- 4. broadcast + directed summon through the real endpoints --------
  const composer = page.locator(".room-composer");
  await composer.locator("input").fill("全员周报：P1 验收广播");
  await page.getByRole("button", { name: "广播" }).click();
  await page.getByText("全员周报：P1 验收广播").waitFor();
  let thread = (await apiGet(`/chat-rooms/${rooms[0].id}/messages`)).messages;
  // the server wraps broadcast prompts with the self-select clause
  assert.equal(thread.some((m) => m.question.includes("全员周报：P1 验收广播")), true);
  ok("broadcast sent and persisted on the room thread");

  await composer.locator("input").fill("@验收会话");
  await composer.getByRole("button", { name: /验收会话/ }).click();
  await composer.locator("input").fill("@验收会话 检查构建");
  await page.getByRole("button", { name: "召唤" }).click();
  await page.getByText("检查构建").first().waitFor();
  let tasks = (await apiGet(`/chat-rooms/${rooms[0].id}/orchestrate`)).tasks;
  assert.equal(
    tasks.some((t) => t.executor_session_id === "cap-chat-first" && t.prompt.includes("检查构建")),
    true,
  );
  ok("directed summon carried the full session id");

  // ---- 5. draft isolation across rooms ------------------------------------
  await page.getByRole("button", { name: "新建聊天室" }).click();
  await dialog.getByPlaceholder(/聊天室名称/).fill("第二房间");
  await dialog.getByRole("button", { name: "创建空聊天室" }).click();
  await page.getByRole("heading", { name: "第二房间" }).waitFor();
  await page.screenshot({ path: join(ARTIFACTS, "room-1440.png"), fullPage: true });
  await page.getByRole("button", { name: /P1 验收房/ }).click({ force: true });
  await page.getByRole("heading", { name: "P1 验收房" }).waitFor();
  ok("room switching keeps the selection explicit");

  // ---- 5b. the room graph beside the conversation --------------------------
  // the header toggle shares its name with the sidebar nav button — scope it
  const headerToggle = (name) =>
    page.locator(".room-chat-header").getByRole("button", { name, exact: true });
  await headerToggle("图谱").click();
  await page.locator(".react-flow__node").first().waitFor({ timeout: 15_000 });
  const roomNodeCount = await page.locator(".react-flow__node").count();
  assert.equal(roomNodeCount, 1, "room graph shows exactly its member(s)");
  await page.screenshot({ path: join(ARTIFACTS, "room-graph-1440.png"), fullPage: true });

  // zoom, then leave and return: the viewport must be remembered
  await page.locator(".react-flow__controls-zoomin").click();
  await page.waitForTimeout(600);
  const viewport = page.locator(".react-flow__viewport");
  const zoomedTransform = await viewport.evaluate((el) => el.style.transform);
  await headerToggle("聊天").click();
  assert.equal(await page.locator(".react-flow").count(), 0, "hidden graph unmounts its renderer");
  await headerToggle("图谱").click();
  await page.locator(".react-flow__viewport").waitFor();
  // the snapshot restore runs on a short timer after remount — wait for the
  // transform to actually return to the zoomed value
  await page.waitForFunction(
    (expected) => document.querySelector(".react-flow__viewport")?.style.transform === expected,
    zoomedTransform,
    { timeout: 8000 },
  );
  ok("room graph renders members only and keeps its viewport across switches");

  // global scope reaches every session and returns to the same room
  await page.getByRole("button", { name: "查看全局图谱" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__node").length >= 5,
    null,
    { timeout: 15_000 },
  );
  await page.getByRole("button", { name: "返回当前房间" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 1);
  assert.ok(page.getByRole("heading", { name: "P1 验收房" }));
  await headerToggle("聊天").click();
  ok("global graph round-trips back to the same room target");

  // ---- 6. peer conversation over web ask ----------------------------------
  await page.getByRole("button", { name: /voice-agent/ }).click();
  await page.getByRole("heading", { name: /与 voice-agent 的对话/ }).waitFor();
  await page.getByPlaceholder(/^向 voice-agent 提问/).fill("P1 验收单聊");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByText("P1 验收单聊").first().waitFor();
  const peerThread = (await apiGet("/web/peer-messages?peer=cap-claude-voice")).messages;
  assert.equal(peerThread.some((m) => m.question === "P1 验收单聊"), true);
  ok("peer conversation used the web-ask path with the full id");

  // ---- 6b. activity history: external channels stay edges, console
  // entries continue in the workspace ----------------------------------------
  await page.getByRole("button", { name: "活动记录", exact: true }).click();
  await page.getByText("M1-B 冒烟清单在哪台机器跑？").first().waitFor();
  await page.getByText("M1-B 冒烟清单在哪台机器跑？").first().click();
  await page.getByText(/Conflux 与 winGhostty 的对话/).waitFor();
  assert.ok(await page.getByPlaceholder(/通道 #/).isVisible(), "edge channel id preserved");
  await page.getByTitle("返回活动记录").click();
  await page.getByText("隔离测试：重试同一条消息").first().waitFor();
  await page.getByText("隔离测试：重试同一条消息").first().click();
  await page.getByRole("heading", { name: /与 Conflux 的对话/ }).waitFor();
  ok("activity entries split correctly between edge view and workspace chat");

  // no fake room ids ever hit the API from the UI
  assert.equal(outbound.some((url) => url.includes("/chat-rooms/0/")), false);
  ok("no roomId=0 requests were issued");

  // ---- 7. narrow viewport: nav drawer, details drawer, composer ----------
  await page.setViewportSize({ width: 390, height: 844 });
  // the session details drawer carried over from step 6 and overlays the
  // main area; screenshot it, then Esc must close it (its header toggle is
  // covered by the overlay itself)
  await page.locator(".workspace-details").waitFor();
  await page.screenshot({ path: join(ARTIFACTS, "details-390.png"), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.locator(".workspace-details").waitFor({ state: "detached" });
  // nav drawer opens and closes over the chat surface
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".mobile-sidebar.is-open").waitFor();
  await page.screenshot({ path: join(ARTIFACTS, "nav-390.png"), fullPage: true, animations: "disabled" });
  // close by tapping the backdrop outside the drawer panel (the drawer
  // itself covers the backdrop's center at this width)
  await page.locator(".mobile-sidebar-backdrop").click({ position: { x: 370, y: 60 } });
  await page.locator(".mobile-sidebar.is-open").waitFor({ state: "detached" });
  // narrow chat: composer and send button stay visible and usable
  await page.getByRole("button", { name: /P1 验收房/ }).click({ force: true });
  await page.getByRole("heading", { name: "P1 验收房" }).waitFor();
  await page.locator(".room-composer input").waitFor();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.screenshot({ path: join(ARTIFACTS, "chat-320.png"), fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `320px viewport must not scroll horizontally (overflow=${overflow}px)`);
  ok("narrow screens keep drawers, composer and send reachable without horizontal scroll");

  // ---- 8. member removal + room deletion through details -----------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /P1 验收房/ }).click({ force: true });
  await page.getByRole("heading", { name: "P1 验收房" }).waitFor();
  const rail = page.locator(".workspace-details");
  if (!(await rail.isVisible())) {
    await page.getByRole("button", { name: "详情", exact: true }).click();
  }
  await rail.getByRole("button", { name: "移出成员 验收会话" }).click();
  await rail.getByRole("button", { name: "确认移出" }).click();
  await page.waitForFunction(async () => {
    const res = await fetch(`/chat-rooms`);
    return (await res.json()).rooms.find((r) => r.name === "P1 验收房")?.members.length === 0;
  });
  ok("member removed via details and confirmed against the API");

  await rail.getByRole("button", { name: "删除房间" }).click();
  await rail.getByRole("button", { name: "确认删除" }).click();
  await page.getByRole("heading", { name: "第二房间" }).waitFor();
  rooms = (await apiGet("/chat-rooms")).rooms;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].name, "第二房间");
  ok("deleting the current room fell back to the remaining room");

  await page.screenshot({ path: join(ARTIFACTS, "final-1440.png"), fullPage: true });
  await browser.close();

  console.log(`\nchat-first smoke: ${passed.length} checks passed`);
  console.log(`artifacts: ${ARTIFACTS}`);
} catch (error) {
  console.error("chat-first smoke FAILED:", error?.message ?? error);
  console.error("--- server tail ---\n" + childLogs.server);
  console.error("--- vite tail ---\n" + childLogs.web);
  process.exitCode = 1;
} finally {
  stop(server);
  stop(web);
  // bounded cleanup of our own temp dir; failures keep it for inspection
  if (!process.exitCode) {
    rmSync(home, { recursive: true, force: true });
  } else {
    console.error(`kept isolated home for inspection: ${home}`);
  }
}
