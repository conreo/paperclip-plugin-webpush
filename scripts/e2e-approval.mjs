/**
 * Live approval notification check.
 *
 * `approval.created` is the plugin's headline trigger and the one that exercises
 * per-user targeting (the activity log stamps it with `responsibleUserId`), so it
 * gets its own end-to-end check rather than being inferred from a test push.
 *
 * Approvals cannot be deleted through the API, so the script rejects its own
 * approval afterwards to leave it in a terminal state.
 *
 * Usage: node scripts/e2e-approval.mjs
 */
import { execFileSync } from "node:child_process";
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
const COMPANY_ID = process.env.SPIKE_COMPANY_ID ?? "acme-company-id";
const CHROME = process.env.SPIKE_CHROME_PATH ?? "/opt/google/chrome-canary/google-chrome-canary";

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

await page.goto(`${BASE}/${PREFIX}/company/settings/instance/plugins/${PLUGIN_ID}`, {
  waitUntil: "domcontentloaded",
});
await page.getByRole("heading", { name: "Notifications on this browser" }).waitFor({ timeout: 30000 });

// Re-registering is idempotent and guarantees a subscription row exists after
// any reinstall (uninstalling a plugin drops its namespace).
await page.getByRole("button", { name: /Enable notifications|Re-register this browser/ }).click();
await waitForRegisteredDevice(page);

const subscription = await page.evaluate(async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();
  const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
  const pushSubscription = await pluginRegistration?.pushManager.getSubscription();
  for (const notification of (await pluginRegistration?.getNotifications()) ?? []) notification.close();
  return { endpoint: pushSubscription?.endpoint ?? null };
});
if (!subscription.endpoint) throw new Error("no push subscription on this browser");

console.log(`registered device: …${subscription.endpoint.slice(-20)}`);

console.log("creating an approval request");
let approvalId = null;
try {
  const created = JSON.parse(
    cli(
      "approval",
      "create",
      "-C",
      COMPANY_ID,
      "--type",
      "hire_agent",
      "--payload",
      JSON.stringify({
        reason: "webpush e2e check",
        agentName: "[webpush e2e] safe to reject",
      }),
      "--json",
    ),
  );
  approvalId = created.id ?? created.approval?.id ?? null;
  console.log(`created approval ${approvalId}`);

  const deadline = Date.now() + 30000;
  let notification = null;
  while (Date.now() < deadline && !notification) {
    notification = await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
      const notifications = (await pluginRegistration?.getNotifications()) ?? [];
      const match = notifications.find((item) => item.title === "Approval needed");
      return match ? { title: match.title, body: match.body, data: match.data } : null;
    });
    if (!notification) await page.waitForTimeout(1000);
  }

  if (!notification) {
    console.log("NO APPROVAL NOTIFICATION ARRIVED");
    const panel = await page.locator("section", { hasText: "Registered devices" }).last().innerText();
    console.log(panel.slice(0, 900));
    process.exitCode = 1;
  } else {
    console.log("=== live approval notification ===");
    console.log(JSON.stringify(notification, null, 2));
    const expected = `/${PREFIX}/approvals/${approvalId}`;
    console.log(
      notification.data?.url === expected
        ? `deep link correct: ${notification.data.url}`
        : `deep link mismatch: got ${notification.data?.url}, expected ${expected}`,
    );
  }
} finally {
  if (approvalId) {
    cli("approval", "reject", approvalId, "--json");
    console.log(`rejected approval ${approvalId} (approvals cannot be deleted)`);
  }
  const panel = await page.locator("section", { hasText: "Registered devices" }).last().innerText();
  console.log("=== delivery ledger ===");
  console.log(panel.slice(0, 900));
  await context.close();
}
