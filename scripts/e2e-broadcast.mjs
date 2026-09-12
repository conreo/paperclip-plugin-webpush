/**
 * Broadcast-path check: an event that names nobody responsible.
 *
 * The targeted path (an event naming a responsible user) is covered by the other
 * checks. This one exercises the fallback, which is the rule that changed: an
 * unassigned event goes to the devices of the event company's active members,
 * resolved from the host, rather than to the devices that happened to be
 * registered from that company.
 *
 * To reach the fallback, the company's default responsible user must be empty for
 * the duration of the check — otherwise the host resolves every event to that
 * user and the targeted path handles it. The script saves the value first and
 * restores it in a finally block.
 *
 * Usage: node scripts/e2e-broadcast.mjs
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  enableNotifications,
  explainMiss,
  launchProfile,
  openSettingsPage,
  readNotifications,
  waitForNotification,
} from "./lib/browser.mjs";

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
// Which company these checks act in. Required rather than defaulted: a company id
// belongs to one instance, and a check that silently acts on the wrong one is worse
// than one that refuses to start.
const COMPANY_ID = process.env.SPIKE_COMPANY_ID;
if (!COMPANY_ID) {
  throw new Error("Set SPIKE_COMPANY_ID to the company these checks should act in.");
}
const PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";

const cliJson = (...args) =>
  JSON.parse(
    execFileSync("paperclipai", [...args, "--api-base", BASE, "--json"], {
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? ".cache/npm" },
    }),
  );

const company = cliJson("company", "get", COMPANY_ID);
const originalResponsibleUser = company.defaultResponsibleUserId ?? null;
console.log(`company default responsible user: ${originalResponsibleUser ?? "(none)"}`);

const { context, page } = await launchProfile("chrome-profile-broadcast");
await openSettingsPage(page);
await enableNotifications(page);
await readNotifications(page, { clear: true });

try {
  // Empty the fallback so the event resolves to nobody responsible.
  cliJson("company", "update", COMPANY_ID, "--payload-json", '{"defaultResponsibleUserId":null}');
  console.log("temporarily cleared the company default responsible user");

  const eventBody = {
    actorType: "system",
    actorId: "webpush-broadcast-check",
    action: "budget.incident.opened",
    entityType: "budget",
    entityId: randomUUID(),
    details: { scope: "monthly", note: "webpush broadcast check" },
  };

  const response = await fetch(`${BASE}/api/companies/${COMPANY_ID}/activity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(eventBody),
  });
  console.log(`logged unassigned activity: HTTP ${response.status}`);

  const notification = await waitForNotification(page, (item) => item.title === "Budget threshold crossed");
  if (!notification) {
    const miss = await explainMiss(page);
    console.log(`NO BROADCAST NOTIFICATION — ${miss.hint}`);
    console.log(miss.panel);
    process.exitCode = 1;
  } else {
    console.log("=== unassigned event delivered through the membership fallback ===");
    console.log(JSON.stringify(notification, null, 2));
    const expected = `/${PREFIX}/activity/budgets`;
    console.log(
      notification.url === expected
        ? `deep link correct: ${notification.url}`
        : `deep link mismatch: got ${notification.url}, expected ${expected}`,
    );
  }
} finally {
  if (originalResponsibleUser) {
    cliJson(
      "company",
      "update",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify({ defaultResponsibleUserId: originalResponsibleUser }),
    );
    console.log(`restored the company default responsible user to ${originalResponsibleUser}`);
  }
  const restored = cliJson("company", "get", COMPANY_ID).defaultResponsibleUserId ?? null;
  console.log(`verified restored value: ${restored}`);
  await context.close();
}
