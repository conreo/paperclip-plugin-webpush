/**
 * Cross-company delivery check.
 *
 * Proves the targeting rule that matters on a multi-company instance: a device
 * registered while looking at company A still receives what its owner is
 * responsible for in company B. Delivery for a named responsible user is
 * user-scoped, so the worker finds that device even though the event's company
 * has no subscriptions of its own.
 *
 * Create a throwaway second company first if you do not have one:
 *   paperclipai company create --payload-json '{"name":"Webpush Crosscompany Test"}'
 *   SPIKE_OTHER_COMPANY_ID=<id> SPIKE_OTHER_PREFIX=<PREFIX> node scripts/e2e-cross-company.mjs
 *
 * Cleans up the issue it creates.
 */
import { execFileSync } from "node:child_process";
import {
  enableNotifications,
  explainMiss,
  launchProfile,
  openSettingsPage,
  readNotifications,
  waitForNotification,
} from "./lib/browser.mjs";

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
const PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
const OTHER_COMPANY_ID = process.env.SPIKE_OTHER_COMPANY_ID;
const OTHER_PREFIX = process.env.SPIKE_OTHER_PREFIX ?? "WEB";

if (!OTHER_COMPANY_ID) throw new Error("set SPIKE_OTHER_COMPANY_ID to a second company's id");

const cli = (...args) =>
  execFileSync("paperclipai", [...args, "--api-base", BASE], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: ".cache/npm" },
  });

const { context, page } = await launchProfile("chrome-profile-cross");
await openSettingsPage(page);
await enableNotifications(page);
console.log(`device registered under company prefix ${PREFIX}`);

// Scope to this browser's own device card: the list may hold several
// devices, and toggling the wrong one would leave this browser unsubscribed.
const toggle = page
  .locator('[data-testid="device-row"][data-device-current="true"]')
  .getByLabel("A new task was created");
if (!(await toggle.isChecked())) {
  await toggle.click();
  await page.waitForFunction(
    () => {
      const row = document.querySelector('[data-testid="device-row"][data-device-current="true"]');
      const labels = [...(row?.querySelectorAll("label") ?? [])];
      const match = labels.find((label) => /A new task was created/.test(label.textContent ?? ""));
      return match?.querySelector("input")?.checked === true;
    },
    null,
    { timeout: 15000 },
  );
  console.log("enabled the issue.created trigger for this device");
}

await readNotifications(page, { clear: true });

const title = `[webpush cross-company] ${Date.now()}`;
let issueId = null;
try {
  const created = JSON.parse(
    cli(
      "issue",
      "create",
      "--company-id",
      OTHER_COMPANY_ID,
      "--title",
      title,
      "--description",
      "Cross-company delivery check for the web push plugin; deleted immediately after.",
      "--json",
    ),
  );
  issueId = created.id ?? created.issue?.id ?? null;
  console.log(`created issue in company ${OTHER_PREFIX} (${issueId})`);

  const notification = await waitForNotification(page, (item) => item.title.startsWith("New task"));
  if (!notification) {
    const miss = await explainMiss(page);
    console.log(`NO NOTIFICATION FOR THE OTHER COMPANY'S EVENT — ${miss.hint}`);
    console.log(miss.panel);
    process.exitCode = 1;
  } else {
    console.log("=== notification from the other company ===");
    console.log(JSON.stringify(notification, null, 2));
    const expected = `/${OTHER_PREFIX}/issues/${issueId}`;
    console.log(
      notification.url === expected
        ? `deep link correct and points at the other company: ${notification.url}`
        : `deep link mismatch: got ${notification.url}, expected ${expected}`,
    );
  }
} finally {
  if (issueId) {
    cli("issue", "delete", issueId, "--yes");
    console.log(`deleted issue ${issueId} (registered under ${PREFIX}, event from ${OTHER_PREFIX})`);
  }
  await context.close();
}
