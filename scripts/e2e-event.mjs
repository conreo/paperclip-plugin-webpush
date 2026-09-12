/**
 * Event-driven end-to-end check.
 *
 * Proves the path the plugin actually exists for: a real board action becomes a
 * plugin event, the worker fans it out to a registered device, and the service
 * worker renders it. Creates and then deletes its own issue so the instance is
 * left as it was found.
 *
 * Usage: node scripts/e2e-event.mjs
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
const PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
const PLUGIN_ID = process.env.SPIKE_PLUGIN_ID ?? "0fe68a3c-40db-4524-b94f-69ca8fc50231";
const COMPANY_ID = process.env.SPIKE_COMPANY_ID ?? "acme-company-id";
const CHROME = process.env.SPIKE_CHROME_PATH ?? "/opt/google/chrome-canary/google-chrome-canary";
const TITLE = `[webpush e2e] event fan-out ${Date.now()}`;

const cli = (...args) =>
  execFileSync("paperclipai", [...args, "--api-base", BASE], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: ".cache/npm" },
  });

const context = await chromium.launchPersistentContext(
  process.env.SPIKE_PROFILE_DIR ?? ".cache/chrome-profile",
  { executablePath: CHROME, headless: true, permissions: ["notifications"] },
);
const page = context.pages()[0] ?? (await context.newPage());

const url = `${BASE}/${PREFIX}/company/settings/instance/plugins/${PLUGIN_ID}`;
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Notifications on this browser" }).waitFor({ timeout: 30000 });

// Ensure this browser is registered (idempotent: the plugin re-registers in place).
const enableButton = page.getByRole("button", { name: /Enable notifications|Re-register this browser/ });
await enableButton.click();
await page.waitForTimeout(6000);

const swState = await page.evaluate(async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();
  const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
  const subscription = await pluginRegistration?.pushManager.getSubscription();
  return { endpoint: subscription?.endpoint ?? null };
});
if (!swState.endpoint) throw new Error("no push subscription on this browser; run e2e-local.mjs first");

// The default subscription excludes issue.created; enable it for this device so
// the event-driven path can be exercised with a cheap, fully reversible action.
const issueCreatedToggle = page.getByLabel("A new task was created");
if (!(await issueCreatedToggle.isChecked())) {
  await issueCreatedToggle.click();
  await page.waitForTimeout(2000);
  console.log("enabled the issue.created trigger for this device");
}

await page.evaluate(async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();
  const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
  for (const notification of (await pluginRegistration?.getNotifications()) ?? []) notification.close();
});

console.log(`creating issue: ${TITLE}`);
let issueId = null;
try {
  const created = JSON.parse(
    cli(
      "issue",
      "create",
      "--company-id",
      COMPANY_ID,
      "--title",
      TITLE,
      "--description",
      "Created by the web push plugin event E2E check; deleted immediately after.",
      "--json",
    ),
  );
  issueId = created.id ?? created.issue?.id ?? null;
  console.log(`created issue ${issueId}`);

  const deadline = Date.now() + 30000;
  let notification = null;
  while (Date.now() < deadline && !notification) {
    notification = await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
      const notifications = (await pluginRegistration?.getNotifications()) ?? [];
      const match = notifications.find((item) => item.title.startsWith("New task"));
      return match ? { title: match.title, body: match.body, data: match.data } : null;
    });
    if (!notification) await page.waitForTimeout(1000);
  }

  if (!notification) {
    console.log("NO NOTIFICATION ARRIVED for the created issue");
    const panel = await page.locator("section", { hasText: "Registered devices" }).last().innerText();
    console.log(panel.slice(0, 800));
    process.exitCode = 1;
  } else {
    console.log("=== notification from a real board event ===");
    console.log(JSON.stringify(notification, null, 2));
    const expectedPath = `/${PREFIX}/issues/${issueId}`;
    console.log(
      notification.data?.url === expectedPath
        ? `deep link correct: ${notification.data.url}`
        : `deep link mismatch: got ${notification.data?.url}, expected ${expectedPath}`,
    );
  }
} finally {
  if (issueId) {
    cli("issue", "delete", issueId, "--yes");
    console.log(`deleted issue ${issueId}`);
  }
  const panel = await page.locator("section", { hasText: "Registered devices" }).last().innerText();
  console.log("=== device panel ===");
  console.log(panel.slice(0, 800));
  await context.close();
}
