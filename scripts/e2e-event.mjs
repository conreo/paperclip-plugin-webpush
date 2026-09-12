/**
 * Event-driven check: a real board action becomes a notification.
 *
 * Creates an issue in the company the browser is registered under, expects the
 * notification, verifies the deep link, and deletes the issue so the instance is
 * left as it was found.
 *
 * Usage: node scripts/e2e-event.mjs
 */
import { execFileSync } from "node:child_process";
import {
  enableNotifications,
  explainMiss,
  launchProfile,
  openSettingsPage,
  readNotifications,
  setDeviceTrigger,
  waitForNotification,
} from "./lib/browser.mjs";

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
const PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
const COMPANY_ID = process.env.SPIKE_COMPANY_ID ?? "acme-company-id";

const cli = (...args) =>
  execFileSync("paperclipai", [...args, "--api-base", BASE], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: ".cache/npm" },
  });

const { context, page } = await launchProfile("chrome-profile-event");
await openSettingsPage(page);
await enableNotifications(page);

// issue.created is off by default; enable it and wait for the write to land
// before firing the event, otherwise the worker correctly finds nobody opted in.
// Scope to this browser's own device card: the list may hold several
// devices, and toggling the wrong one would leave this browser unsubscribed.
if (await setDeviceTrigger(page, "issue.created", true)) {
  console.log("enabled the issue.created trigger for this device");
}

await readNotifications(page, { clear: true });

const title = `[webpush e2e] event fan-out ${Date.now()}`;
let issueId = null;
try {
  const created = JSON.parse(
    cli(
      "issue",
      "create",
      "--company-id",
      COMPANY_ID,
      "--title",
      title,
      "--description",
      "Created by the web push plugin event check; deleted immediately after.",
      "--json",
    ),
  );
  issueId = created.id ?? created.issue?.id ?? null;
  console.log(`created issue ${issueId}`);

  const notification = await waitForNotification(page, (item) => item.title.startsWith("New task"));
  if (!notification) {
    const miss = await explainMiss(page);
    console.log(`NO NOTIFICATION FOR THE CREATED ISSUE — ${miss.hint}`);
    console.log(miss.panel);
    process.exitCode = 1;
  } else {
    console.log("=== notification from a real board event ===");
    console.log(JSON.stringify(notification, null, 2));
    const expected = `/${PREFIX}/issues/${issueId}`;
    console.log(
      notification.url === expected
        ? `deep link correct: ${notification.url}`
        : `deep link mismatch: got ${notification.url}, expected ${expected}`,
    );
  }
} finally {
  if (issueId) {
    cli("issue", "delete", issueId, "--yes");
    console.log(`deleted issue ${issueId}`);
  }
  await context.close();
}
