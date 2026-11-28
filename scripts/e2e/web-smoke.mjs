import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
import { withBrowser } from "./chat-first-smoke.mjs";
import { withWorkspaceFixture } from "./workspace-fixture.mjs";

const artifacts = fileURLToPath(new URL("../../test-results/e2e/", import.meta.url));
const peerId = "cap-claude-voice";

await withWorkspaceFixture(async ({ web, request }) => {
  mkdirSync(artifacts, { recursive: true });
  await withBrowser(() => chromium.launch(), async (browser) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const shot = (name) => page.screenshot({ path: join(artifacts, name + ".png") });
    const byId = (id) => page.getByTestId(id);
    const assertFits = async () => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    try {
      const treeReady = page.waitForResponse((res) => new URL(res.url()).pathname === "/workspace/tree");
      await page.goto(web);
      assert.equal((await treeReady).ok(), true);
      const tree = await request("/workspace/tree");
      assert.equal(tree.projects.length, 4);
      assert.equal(tree.threads.length, 4);
      await byId("sidebar-thread-" + peerId).waitFor();

      for (const [preset, mode] of [["浅色", "light"], ["终端蓝黑", "dark"]]) {
        await byId("rail-settings-btn").click();
        await byId("theme-preset-" + preset).click();
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, mode);
        await shot("theme-" + mode + "-desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        await assertFits();
        await shot("theme-" + mode + "-narrow");
        await page.setViewportSize({ width: 1440, height: 900 });
        await byId("rail-graph-btn").click();
        await byId("mesh-node-" + peerId).waitFor();
        await shot("theme-" + mode + "-graph");
      }
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");

      await byId("rail-history-btn").click();
      const history = byId("call-history-modal");
      await history.getByText("M1-B 冒烟清单在哪台机器跑？", { exact: true }).waitFor();
      await history.getByText("Windows 真机，13 条清单已过 9 条。", { exact: true }).waitFor();
      await history.getByRole("button").click();

      await byId("rail-graph-btn").click();
      await byId("node-enter-" + peerId).click();
      const workbench = byId("agent-workbench").first();
      const composer = workbench.getByTestId("workbench-composer-input");
      await composer.fill("E2E smoke message");
      const posted = page.waitForResponse(
        (res) => new URL(res.url()).pathname === "/mesh/calls" && res.request().method() === "POST",
      );
      await workbench.getByTestId("composer-send-btn").click();
      const response = await posted;
      assert.equal(response.status(), 201);
      const { message, delivery_method } = await response.json();
      assert.equal(message.to_session, peerId);
      assert.equal(delivery_method, "external-mcp-inbox");
      await workbench.getByTestId("peer-call-card-" + message.id).waitFor();
      await shot("peer-call-desktop");

      const active = (await request("/mesh/calls?status=active")).calls;
      assert.equal(active.filter((call) => call.question === message.question).length, 1);
      const hungUp = await request("/mesh/calls/" + message.id + "/hangup", { method: "POST" });
      assert.equal(hungUp.message.status, "cancelled");
      assert.equal((await request("/messages?to=" + peerId)).messages.filter((call) => call.id === message.id).length, 1);

      await byId("sidebar-new-workspace-btn").click();
      const modal = byId("new-workspace-modal");
      await modal.getByTestId("engine-card-codex").waitFor();
      assert.equal(await workbench.getByTestId("composer-interrupt-btn").count(), 0);
      const workdir = modal.getByTestId("new-workspace-dir-input");
      await workdir.fill("");
      await modal.getByTestId("new-agent-submit-btn").click();
      assert.equal(await workdir.evaluate((input) => input.validity.valueMissing), true);
      await modal.waitFor();
      await shot("new-workspace-desktop");
      await modal.getByTestId("new-workspace-cancel-btn").click();

      await page.setViewportSize({ width: 390, height: 844 });
      await byId("rail-sidebar-toggle-btn").click();
      await byId("workspace-sidebar").evaluate((el) => {
        if (!el.classList.contains("is-collapsed")) throw Error("sidebar did not collapse");
      });
      await assertFits();
      await byId("rail-history-btn").click();
      await history.getByText("E2E smoke message", { exact: true }).waitFor();
      const panel = await history.locator(":scope > div").boundingBox();
      assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= 390);
      await shot("history-narrow");
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error({ errors });
      await shot("web-smoke-failure");
      await context.tracing.stop({ path: join(artifacts, "web-smoke-failure.zip") });
      throw error;
    }
  });
}, { seedFlags: ["--controls"] });

console.log("E2E web smoke tests passed");
