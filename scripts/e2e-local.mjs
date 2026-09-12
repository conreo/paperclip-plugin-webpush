/**
 * Test-push check: does this browser receive a real push at all?
 *
 * Grants permission, registers the plugin's service worker, creates a Push API
 * subscription, asks the worker to send a test push, and confirms the service
 * worker actually rendered the notification. This is the check that isolates
 * "the pipeline is broken" from "that board event never happened".
 *
 * Usage: node scripts/e2e-local.mjs
 */
import {
  currentEndpoint,
  enableNotifications,
  explainMiss,
  launchProfile,
  openSettingsPage,
  readNotifications,
  waitForNotification,
} from "./lib/browser.mjs";

const { context, page } = await launchProfile("chrome-profile-local");
await openSettingsPage(page);

await enableNotifications(page);

const subscription = await currentEndpoint(page);
console.log(`push subscription: …${subscription.endpoint?.slice(-20) ?? "(none)"}`);
console.log(`service worker registrations on this origin: ${subscription.registrationCount}`);
for (const scope of subscription.scopes) console.log(`  ${scope}`);
if (!subscription.endpoint) throw new Error("no Push API subscription was created");

await readNotifications(page, { clear: true });
await page.getByRole("button", { name: "Send test notification" }).click();

const notification = await waitForNotification(page, (item) =>
  item.title === "Paperclip notifications are on",
);

if (!notification) {
  const miss = await explainMiss(page);
  console.log(`NO TEST NOTIFICATION RENDERED — ${miss.hint}`);
  console.log(miss.panel);
  process.exitCode = 1;
} else {
  console.log("=== notification rendered by the plugin's service worker ===");
  console.log(JSON.stringify(notification, null, 2));
}

await context.close();
