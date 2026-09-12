/**
 * End-to-end push check against a running Paperclip instance.
 *
 * Drives the plugin's own settings page in a real Chrome: grants notification
 * permission, lets the page register its service worker and create a Push API
 * subscription, then asks the worker to send a real encrypted push through the
 * browser's push service and confirms a notification was actually shown.
 *
 * Usage: node scripts/e2e-local.mjs
 *   SPIKE_BASE_URL, SPIKE_COMPANY_PREFIX, SPIKE_PLUGIN_ID, SPIKE_CHROME_PATH
 */
import { chromium } from "playwright";


// The browser can hold a PushSubscription long before the worker has the row:
// the device list is what proves the register action committed, and without a
// committed row an event legitimately has zero recipients and is skipped.
const waitForRegisteredDevice = async (page, timeout = 45000) => {
  await page.waitForFunction(
    () => /Registered devices \([1-9]/.test(document.body.innerText),
    null,
    { timeout },
  );
};

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
const PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
const PLUGIN_ID = process.env.SPIKE_PLUGIN_ID ?? "0fe68a3c-40db-4524-b94f-69ca8fc50231";
const CHROME = process.env.SPIKE_CHROME_PATH ?? "/opt/google/chrome-canary/google-chrome-canary";

const url = `${BASE}/${PREFIX}/company/settings/instance/plugins/${PLUGIN_ID}`;

// A persistent profile is required: Chrome disables the Push API entirely in
// incognito contexts, which is what `browser.newContext()` creates.
const userDataDir = process.env.SPIKE_PROFILE_DIR ?? ".cache/chrome-profile";
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME,
  headless: true,
  permissions: ["notifications"],
});
const browser = context.browser();
const page = context.pages()[0] ?? (await context.newPage());

const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  // The host 404s on /api/companies/<id>/built-in-agents on this instance for
  // reasons unrelated to this plugin; keep it out of the report.
  if (message.type() === "error" && !message.text().includes("status of 404")) {
    errors.push(`console: ${message.text()}`);
  }
});

console.log(`→ ${url}`);
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Notifications on this browser" }).waitFor({ timeout: 30000 });
console.log("settings page rendered");

const readPanel = async () => {
  const body = await page.locator("main, [role=main], body").first().innerText();
  return body.slice(0, 900);
};

// --- Step 1: enable notifications on this browser -------------------------
await page.getByRole("button", { name: /Enable notifications|Re-register this browser/ }).click();
await waitForRegisteredDevice(page);

const afterEnable = await readPanel();
console.log("=== panel after enable ===");
console.log(afterEnable);

const subscription = await page.evaluate(async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();
  const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
  if (!pluginRegistration) return { registered: false };
  const pushSubscription = await pluginRegistration.pushManager.getSubscription();
  return {
    registered: true,
    scope: pluginRegistration.scope,
    endpoint: pushSubscription?.endpoint ?? null,
  };
});
console.log("subscription →", JSON.stringify(subscription, null, 2));

if (!subscription.endpoint) {
  console.log("no Push API subscription was created; stopping before the send step");
  console.log("page errors:", errors.slice(-5).join("\n") || "(none)");
  await context.close();
  process.exit(1);
}

// --- Step 2: real delivery -------------------------------------------------
await page.getByRole("button", { name: "Send test notification" }).click();
// Poll rather than sleep: a shown notification can be dismissed by the OS before
// a fixed wait elapses, which reads as "not delivered" even though it was.
let shown = [];
const deadline = Date.now() + 25000;
while (Date.now() < deadline && shown.length === 0) {
  shown = await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
    const notifications = (await pluginRegistration?.getNotifications()) ?? [];
    return notifications.map((item) => ({ title: item.title, body: item.body, tag: item.tag }));
  });
  if (shown.length === 0) await page.waitForTimeout(500);
}

const afterTest = await readPanel();
console.log("=== panel after test send ===");
console.log(afterTest);

console.log("notifications currently shown by our worker →", JSON.stringify(shown, null, 2));

const devicePanel = await page
  .locator("section", { hasText: "Registered devices" })
  .last()
  .innerText();
console.log("=== device panel ===");
console.log(devicePanel.slice(0, 1200));

if (errors.length) {
  console.log("=== page errors ===");
  console.log([...new Set(errors)].slice(0, 10).join("\n"));
}

await context.close();
