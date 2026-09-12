/**
 * Spike check 1 + 3 (browser side).
 *
 * Loads the plugin's settings page in a real Chrome against the local Paperclip
 * instance and answers:
 *   - does a service worker registered at /_plugins/<id>/ui/sw.js coexist with
 *     the app's own root-scoped /sw.js, and is it actually ours (postMessage pong)?
 *   - what does the worker report for the namespace migration and event wiring?
 *
 * Usage: node scripts/spike-sw.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
const COMPANY_PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
const PLUGIN_KEY = process.env.SPIKE_PLUGIN_KEY ?? "conreo.webpush";
const url = `${BASE}/${COMPANY_PREFIX}/company/settings/instance/plugins/${PLUGIN_KEY}`;

const browser = await chromium.launch({
  // Playwright's bundled Chromium is not downloaded here; use whichever real
  // browser this workstation has. Chrome Canary first: it carries the real push
  // service integration, which is what production delivery uses.
  executablePath: process.env.SPIKE_CHROME_PATH ?? "/opt/google/chrome-canary/google-chrome-canary",
  headless: true,
});
const context = await browser.newContext({ permissions: ["notifications"] });
const page = await context.newPage();

const consoleLines = [];
page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));

console.log(`→ ${url}`);
await page.goto(url, { waitUntil: "domcontentloaded" });

// The app itself registers /sw.js on window load.
await page.waitForFunction(() => navigator.serviceWorker?.controller !== undefined, null, { timeout: 20000 });

try {
  await page.getByRole("heading", { name: "Web Push Notifications" }).waitFor({ timeout: 20000 });
} catch {
  console.log("plugin UI heading not found; page text follows:");
  console.log((await page.locator("body").innerText()).slice(0, 1500));
  throw new Error("plugin settings page did not render");
}

console.log("settings page rendered");

const registrationsBefore = await page.evaluate(async () => {
  const all = await navigator.serviceWorker.getRegistrations();
  return all.map((r) => ({ scope: r.scope, scriptURL: r.active?.scriptURL ?? null }));
});
console.log("registrations before plugin action:", JSON.stringify(registrationsBefore, null, 2));

await page.getByRole("button", { name: "Register service worker" }).click();
await page.getByText("registrations on this origin:").waitFor({ timeout: 20000 });

const report = await page.evaluate(async () => {
  const all = await navigator.serviceWorker.getRegistrations();
  const pluginRegistration = all.find((r) => r.scope.includes("/_plugins/"));
  let pong = null;
  if (pluginRegistration?.active) {
    pong = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 3000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      pluginRegistration.active.postMessage({ type: "ping" }, [channel.port2]);
    });
  }
  return {
    secureContext: window.isSecureContext,
    permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
    registrations: all.map((r) => ({
      scope: r.scope,
      scriptURL: r.active?.scriptURL ?? null,
      state: r.active?.state ?? null,
    })),
    pluginWorkerPong: pong,
  };
});

console.log("=== browser report ===");
console.log(JSON.stringify(report, null, 2));

const workerSection = await page
  .locator("section", { hasText: "Worker observations" })
  .last()
  .innerText();
console.log("=== worker observations (from settings page) ===");
console.log(workerSection.slice(0, 2000));

if (consoleLines.length) {
  console.log("=== page console ===");
  console.log(consoleLines.slice(-15).join("\n"));
}

await browser.close();
