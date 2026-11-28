import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { withWorkspaceFixture } from "./workspace-fixture.mjs";

const artifacts = fileURLToPath(new URL("../../test-results/e2e/chat-first/", import.meta.url));
const first = "cap-chat-first";
const twin = "cap-chat-twin";

/**
 * Browser lifecycle seam: the browser closes on EVERY path — steps throwing,
 * steps finishing, anything in between. Exported for the cleanup regression
 * (chat-first-smoke.test.mjs); the smoke body itself runs through main().
 */
export async function withBrowser(launchBrowser, steps) {
  const browser = await launchBrowser();
  let stepsThrew = false;
  try {
    return await steps(browser);
  } catch (error) {
    stepsThrew = true;
    throw error;
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      if (!stepsThrew) {
        // steps succeeded — a failed cleanup IS the run's failure; a
        // swallowed close here would report a green run with a live browser
        throw closeError;
      }
      // steps already failed: keep the original business error as the
      // rejection, but never lose the cleanup failure silently
      console.error("chat-first: browser close failed after step failure:", closeError);
    }
  }
}

async function main() {
  mkdirSync(artifacts, { recursive: true });
  await withWorkspaceFixture(async ({ web, request }) => {
    const post = (path, body, status = 200) => request(path, { method: "POST", body, status });
    const initial = await request("/workspace/tree");
    assert.deepEqual(initial.rooms, []);
    const twins = initial.threads.filter((thread) => thread.name === "验收会话");
    assert.deepEqual(new Set(twins.map((thread) => thread.id)), new Set([first, twin]));
    const { room } = await post("/rooms", { name: "P1 验收房" }, 201);
    const detail = () => request("/rooms/" + room.id);
    assert.deepEqual((await detail()).room.members, []);
    for (const thread_id of [first, twin]) await post("/rooms/" + room.id + "/join", { thread_id });
    assert.deepEqual(new Set((await detail()).room.members), new Set([first, twin]));

    const broadcast = "全员周报：P1 验收广播";
    const delivered = await post("/rooms/" + room.id + "/broadcast", { prompt: broadcast });
    assert.deepEqual(new Set(delivered.dispatched.map((task) => task.thread_id)), new Set([first, twin]));
    const directed = "检查构建";
    const summon = await post("/rooms/" + room.id + "/summon", { executor_thread_id: first, prompt: directed });
    const { tasks, messages } = await detail();
    assert.equal(messages.filter((msg) => msg.question.includes(broadcast)).length, 2);
    assert.deepEqual(
      tasks.filter((task) => task.prompt === directed).map((task) => task.executor_thread_id),
      [first],
    );
    assert.equal(messages.filter((msg) => msg.id === summon.message_id && msg.question.endsWith(directed) && msg.to_session === first).length, 1);
    console.log("✓ v2 room membership, broadcast and directed sends over HTTP");

    await withBrowser(() => chromium.launch(), async (browser) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const failedRequests = [];
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("request", (req) => {
        if (new URL(req.url()).pathname.startsWith("/rooms/0/")) failedRequests.push(req.url());
      });
      const shot = (name) => page.screenshot({ path: join(artifacts, name + ".png"), animations: "disabled" });
      const byId = (id) => page.getByTestId(id);
      try {
        await page.goto(web);
        const sidebar = byId("workspace-sidebar");
        for (const id of [first, twin]) {
          const entry = sidebar.getByTestId("sidebar-thread-" + id);
          await entry.getByText("验收会话", { exact: true }).waitFor();
          await entry.click();
          await byId("agent-workbench").getByTestId("peer-call-card-" +
            messages.find((msg) => msg.to_session === id && msg.question.includes(broadcast)).id).waitFor();
        }
        await shot("workspace-1440");
        console.log("✓ same-name peers open distinct workbenches with their own room messages");

        await byId("rail-graph-btn").click();
        await byId("mesh-node-" + first).waitFor();
        await byId("mesh-node-" + twin).waitFor();
        assert.equal(await page.locator('[data-testid^="mesh-node-"]').count(), 6);
        await shot("mesh-1440");
        await byId("node-enter-" + first).click();
        const workbench = byId("agent-workbench").first();
        const composer = workbench.getByTestId("workbench-composer-input");
        await composer.fill("P1 验收单聊");
        const posted = page.waitForResponse((res) =>
          new URL(res.url()).pathname === "/mesh/calls" && res.request().method() === "POST");
        await workbench.getByTestId("composer-send-btn").click();
        const response = await posted;
        assert.equal(response.status(), 201);
        const { message } = await response.json();
        assert.equal(message.to_session, first);
        await workbench.getByTestId("peer-call-card-" + message.id).waitFor();
        const peerCalls = (await request("/messages?to=" + first)).messages;
        assert.equal(peerCalls.filter((msg) => msg.question === "P1 验收单聊" && msg.room_id === null).length, 1);
        console.log("✓ graph-to-workbench navigation and peer conversation");

        for (const width of [1024, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          if (width === 390) await byId("rail-sidebar-toggle-btn").click();
          await composer.waitFor();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          const send = await workbench.getByTestId("composer-send-btn").boundingBox();
          assert.ok(send && send.x >= 0 && send.x + send.width <= width,
            "send button must fit viewport " + width);
          await shot("workspace-" + width);
        }
        assert.deepEqual(failedRequests, []);
        assert.deepEqual(pageErrors, []);
        console.log("✓ workbench composer fits 1024px, 390px and 320px");
      } catch (error) {
        await shot("failure");
        throw error;
      }
    });

    const { room: remaining } = await post("/rooms", { name: "第二房间" }, 201);
    await post("/rooms/" + room.id + "/leave", { thread_id: first });
    assert.deepEqual((await detail()).room.members, [twin]);
    await request("/rooms/" + room.id, { method: "DELETE" });
    const { rooms } = await request("/rooms");
    assert.deepEqual(rooms.map((item) => item.id), [remaining.id]);
    await request("/rooms/" + room.id, { status: 404 });
    console.log("✓ member removal, room deletion and isolated second room");
  }, { serverPort: 19529, webPort: 5201, seedFlags: ["--controls", "--chat-first"] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
