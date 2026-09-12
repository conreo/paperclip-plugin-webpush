/**
 * Touch-device check.
 *
 * The host applies a 44px minimum height to every `button`, `[role="button"]`,
 * `input` and `select` under `(pointer: coarse)` — a touch-target rule — and exempts
 * its own inline widgets through `data-slot` markers, with the note that "the
 * surrounding row provides the touch area". Plugin controls written as plain
 * buttons therefore inherit the 44px floor: on a tablet the switch drew a 44px
 * capsule around a 16px thumb, and every icon button stretched with it.
 *
 * This check fails if that happens again: it measures the switch, the icon buttons
 * and the chips under a coarse pointer, and requires the design sizes.
 *
 * Usage: node scripts/e2e-touch.mjs
 */
import { chromium } from "playwright";
import { CHROME, enableNotifications, pluginSettingsUrl } from "./lib/browser.mjs";

const context = await chromium.launchPersistentContext(".cache/profile-touch", {
  executablePath: CHROME,
  headless: true,
  // `hasTouch` is what makes Chrome report `pointer: coarse`, which is what the
  // host's touch rule keys on — a plain narrow viewport does not reproduce it.
  hasTouch: true,
  isMobile: true,
  viewport: { width: 820, height: 1180 },
  deviceScaleFactor: 2,
  // Same grant `launchProfile` gives: without it the page cannot ask for
  // permission and the check fails for a reason that has nothing to do with touch.
  permissions: ["notifications"],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(pluginSettingsUrl(), { waitUntil: "domcontentloaded" });
await page.locator('[data-testid="enable-notifications"]').waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
await enableNotifications(page);

// Open a trigger so its editor, chips and object list exist to be measured.
await page.locator('[data-testid^="open-"]').first().click();
await page.waitForTimeout(500);
await page.locator('[data-testid^="template-title-"]').first().click();
await page.locator('[data-testid$="-insert"]').first().click();
await page.waitForTimeout(300);
await page.locator('.pcp-insert-item').first().click();
await page.waitForTimeout(300);

const report = await page.evaluate(() => {
  const size = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height) };
  };
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const switchEl = document.querySelector(".pcp-switch");
  const thumb = document.querySelector(".pcp-switch-thumb");
  const switchBox = switchEl?.getBoundingClientRect();
  const thumbBox = thumb?.getBoundingClientRect();
  return {
    coarse,
    switch: size(".pcp-switch"),
    thumb: size(".pcp-switch-thumb"),
    // The thumb must sit inside its track, not float in a stretched capsule.
    thumbInsideTrack: Boolean(switchBox && thumbBox && thumbBox.height <= switchBox.height),
    insertButton: size(".pcp-insert-btn"),
    objectTool: size(".pcp-object-tool"),
    helpButton: size(".pcp-help"),
    chip: size(".pcp-object"),
    row: size('[data-testid^="open-"]'),
  };
});

const EXPECTED = [
  ["switch", "44x20", (r) => r.switch?.h === 20 && r.switch?.w === 44],
  ["thumb", "24x16", (r) => r.thumb?.h === 16 && r.thumb?.w === 24],
  ["thumb inside its track", "true", (r) => r.thumbInsideTrack],
  ["insert button", "20px tall", (r) => r.insertButton?.h === 20],
  ["object tool", "16px tall", (r) => r.objectTool?.h === 16],
  ["help mark", "14px tall", (r) => r.helpButton?.h === 14],
  ["chip", "one line tall", (r) => Boolean(r.chip) && r.chip.h <= 22],
];

console.log(`pointer: coarse = ${report.coarse}, sizes:`, JSON.stringify(report));
let failed = false;
for (const [name, wanted, check] of EXPECTED) {
  const ok = check(report);
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name} is ${wanted}`);
}

if (!report.coarse) {
  console.log("FAIL: the page did not report a coarse pointer, so nothing was exercised");
  failed = true;
}

await context.close();
if (failed) process.exitCode = 1;
