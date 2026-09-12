/**
 * Live approval notification check.
 *
 * `approval.created` is the plugin's headline trigger and the one that exercises
 * per-user targeting, so it gets its own check rather than being inferred from a
 * test push. Approvals cannot be deleted through the API, so the script rejects
 * its own approval afterwards to leave it terminal.
 *
 * Usage: node scripts/e2e-approval.mjs
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
// Which company these checks act in. Required rather than defaulted: a company id
// belongs to one instance, and a check that silently acts on the wrong one is worse
// than one that refuses to start.
const COMPANY_ID = process.env.SPIKE_COMPANY_ID;
if (!COMPANY_ID) {
  throw new Error("Set SPIKE_COMPANY_ID to the company these checks should act in.");
}

const cli = (...args) =>
  execFileSync("paperclipai", [...args, "--api-base", BASE], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? ".cache/npm" },
  });

const { context, page } = await launchProfile("chrome-profile-approval");
await openSettingsPage(page);
await enableNotifications(page);
await readNotifications(page, { clear: true });

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
      JSON.stringify({ reason: "webpush e2e check", agentName: "[webpush e2e] safe to reject" }),
      "--json",
    ),
  );
  approvalId = created.id ?? created.approval?.id ?? null;
  console.log(`created approval ${approvalId}`);

  const notification = await waitForNotification(page, (item) => item.title === "Approval needed");
  if (!notification) {
    const miss = await explainMiss(page);
    console.log(`NO APPROVAL NOTIFICATION — ${miss.hint}`);
    console.log(miss.panel);
    process.exitCode = 1;
  } else {
    console.log("=== live approval notification ===");
    console.log(JSON.stringify(notification, null, 2));
    const expected = `/${PREFIX}/approvals/${approvalId}`;
    console.log(
      notification.url === expected
        ? `deep link correct: ${notification.url}`
        : `deep link mismatch: got ${notification.url}, expected ${expected}`,
    );
  }
} finally {
  if (approvalId) {
    cli("approval", "reject", approvalId, "--json");
    console.log(`rejected approval ${approvalId} (approvals cannot be deleted)`);
  }
  await context.close();
}
