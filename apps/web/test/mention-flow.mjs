/**
 * UI regression: the @-mention composer in the message-flow tab.
 *
 * Covers the class of bug where typing @ (half- or full-width) failed to
 * open the session picker (IME full-width ＠, stale bundle, proxy misses).
 * Deliberately does NOT send — an ask would deliver real mail and trigger
 * an auto-answer wake; the send path is covered by server-side tests.
 *
 * Run with the dev stack up (npm run dev:all or dev:desktop):
 *   node apps/web/test/mention-flow.mjs
 * Exits 0 on pass, 1 on failure with a screenshot at %TEMP%/mention-fail.png.
 */
import { chromium } from "playwright";
import os from "node:os";
import { join } from "node:path";

const URL = process.env.MUILTCHAT_WEB_URL ?? "http://127.0.0.1:5173";
const results = [];
const check = (name, ok) => {
  results.push([name, ok]);
  console.log(`${ok ? "✓" : "✗"} ${name}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "消息流" }).click();
  await page.waitForTimeout(1000);

  // 1. composer present at top of the message tab
  const composer = page.getByPlaceholder(/选择会话|@某个会话/);
  check("composer visible", await composer.isVisible());

  // 2. ASCII @ opens the picker with candidate sessions
  await composer.click();
  await composer.fill("@");
  await page.waitForTimeout(600);
  const pickerItems = page.locator("button:has(span)");
  const candidateCount = await page
    .locator("div.absolute.z-10 button")
    .count();
  check("ASCII @ opens picker with candidates", candidateCount > 0);

  // 3. full-width ＠ (Chinese IME) also opens it
  await composer.fill("＠");
  await page.waitForTimeout(600);
  const fwCount = await page.locator("div.absolute.z-10 button").count();
  check("full-width ＠ opens picker", fwCount > 0);

  // 4. selecting a candidate pins the target chip with a badge
  if (candidateCount > 0) {
    await composer.fill("@");
    await page.waitForTimeout(600);
    await page.locator("div.absolute.z-10 button").first().click();
    await page.waitForTimeout(300);
    const chip = page.locator("span.rounded-full, span.inline-flex").first();
    check("target chip pinned after selection", await chip.isVisible());
    const badge = await page
      .locator("text=/在线|正在回复|离线/")
      .first()
      .isVisible()
      .catch(() => false);
    check("status badge shown", badge);

    // 5. Escape clears the target back to empty (placeholder changes after
    // selection, so re-grab the input via its stable textbox role)
    const input = page.getByRole("textbox", { name: /提问|选择会话/ });
    await input.press("Escape");
    await page.waitForTimeout(300);
    const hint = await page.getByText("输入 @ 选择会话").isVisible().catch(() => false);
    check("Escape clears target", hint);
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (err) {
  console.error("test crashed:", err.message);
  await page.screenshot({ path: join(os.tmpdir(), "mention-fail.png") });
  process.exitCode = 1;
} finally {
  await browser.close();
}
