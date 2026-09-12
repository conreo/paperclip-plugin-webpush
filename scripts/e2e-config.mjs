/**
 * Configuration round-trip check.
 *
 * Proves the three things a configuration feature has to do:
 *   1. a change saves through the host's admin-gated config API,
 *   2. it survives a reload (it is the stored value being rendered, not local
 *      state),
 *   3. it changes behaviour — a browser enabled afterwards starts with the
 *      configured triggers instead of the shipped ones.
 *
 * The original configuration is restored at the end.
 *
 * The page renders the host's switch control (`role="switch"` with
 * `aria-checked`), not a checkbox, so state is read from that attribute and
 * changed by clicking the switch itself.
 *
 * Usage: node scripts/e2e-config.mjs
 */
import {
  enableNotifications,
  launchProfile,
  openSettingsPage,
  pluginSettingsUrl,
} from "./lib/browser.mjs";

const COMPANY_ID = process.env.SPIKE_COMPANY_ID ?? "acme-company-id";
const UNASSIGNED_TESTID = "notify-unassigned";
const DECISION_TRIGGER = "decision.created";

/**
 * Read the "Organization defaults" section: its trigger rows and, separately,
 * the unassigned-events switch.
 */
const readOrgDefaults = (page) =>
  page.evaluate((unassignedTestId) => {
    // Keyed by event type, not by label: the labels are nouns now, and "Decision"
    // is a prefix of "Decision overdue", so substring matching would be ambiguous.
    const readRows = (root) =>
      [...root.querySelectorAll(".pcp-toggle-row")].map((row) => {
        const toggle = row.querySelector('[role="switch"]');
        return {
          type: toggle?.getAttribute("data-testid")?.replace("default-trigger-", "") ?? null,
          label: row.querySelector(".pcp-toggle-label")?.textContent?.trim() ?? "",
          checked: toggle?.getAttribute("aria-checked") === "true",
        };
      });

    const section = document.querySelector('[data-testid="org-defaults"]');
    if (!section) return null;
    const rows = readRows(section);
    const unassignedToggle = section.querySelector(`[data-testid="${unassignedTestId}"]`);
    return {
      triggers: rows.filter((row) => row.type !== null),
      notifyUnassigned: unassignedToggle ? unassignedToggle.getAttribute("aria-checked") === "true" : null,
    };
  }, UNASSIGNED_TESTID);

const readDeviceTriggers = async (page) => {
  // The card is rendered after the device list refreshes, so wait for it rather
  // than reading an empty page and reporting "no triggers".
  await page
    .locator('[data-testid="device-row"][data-device-current="true"] .pcp-toggle-row')
    .first()
    .waitFor({ timeout: 20000 });
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="device-row"][data-device-current="true"] .pcp-toggle-row')]
      .map((row) => ({
        type:
          row.querySelector('[role="switch"]')?.getAttribute("data-testid")?.replace("device-trigger-", "") ?? null,
        label: row.querySelector(".pcp-toggle-label")?.textContent?.trim() ?? "",
        checked: row.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true",
      }))
      // The card's own header row carries no switch.
      .filter((row) => row.type !== null),
  );
};

/** Click a switch only when it is not already in the wanted state. */
const setSwitch = async (page, selector, wanted) => {
  await page.evaluate(
    ({ selector, wanted }) => {
      const toggle = document.querySelector(selector);
      if (!toggle) return;
      if ((toggle.getAttribute("aria-checked") === "true") !== wanted) toggle.click();
    },
    { selector, wanted },
  );
};

const clickTrigger = async (page, eventType, wanted) => {
  await page.evaluate(
    ({ eventType, wanted }) => {
      const toggle = document.querySelector(`[data-testid="default-trigger-${eventType}"]`);
      if (!toggle) return;
      if ((toggle.getAttribute("aria-checked") === "true") !== wanted) toggle.click();
    },
    { eventType, wanted },
  );
};

/** Wait for the save outcome the page reports, by test id rather than wording. */
const waitForSaveOutcome = async (page) => {
  try {
    await page.waitForFunction(
      () =>
        Boolean(document.querySelector('[data-testid="config-notice"]')) ||
        Boolean(document.querySelector('[data-testid="config-error"]')),
      null,
      { timeout: 20000 },
    );
  } catch {
    return "timeout waiting for a save outcome";
  }
  return page.evaluate(() => {
    const failure = document.querySelector('[data-testid="config-error"]');
    if (failure) return `error: ${failure.textContent?.trim() ?? ""}`;
    return document.querySelector('[data-testid="config-notice"]') ? "saved" : "unknown";
  });
};

// --- 1. Read the saved configuration as installed ---------------------------
const { context: ctxA, page: pageA } = await launchProfile("chrome-profile-config-a");
await openSettingsPage(pageA);
await enableNotifications(pageA);
await pageA.waitForTimeout(1500);

const original = await readOrgDefaults(pageA);
if (!original) throw new Error("could not find the Organization defaults section");
console.log("saved configuration:", JSON.stringify(original));

// --- 2. Change it and save --------------------------------------------------
for (const trigger of original.triggers) {
  await clickTrigger(pageA, trigger.type, trigger.type === DECISION_TRIGGER);
}
await setSwitch(pageA, `[data-testid="${UNASSIGNED_TESTID}"]`, false);

await pageA.getByTestId("save-org-defaults").click();
const notice = await waitForSaveOutcome(pageA);
console.log("save outcome:", notice);
if (notice !== "saved") {
  await ctxA.close();
  throw new Error(`configuration did not save → ${notice}`);
}

// --- 3. Reload: the rendered values must come from storage ------------------
await pageA.reload({ waitUntil: "domcontentloaded" });
await openSettingsPage(pageA);
await pageA.waitForTimeout(2500);
const afterReload = await readOrgDefaults(pageA);
console.log("after reload:", JSON.stringify(afterReload));

const persisted =
  afterReload?.notifyUnassigned === false &&
  afterReload.triggers.filter((t) => t.checked).length === 1 &&
  afterReload.triggers.some((t) => t.checked && t.type === DECISION_TRIGGER);
console.log(persisted ? "PASS: the saved configuration survived a reload" : "FAIL: configuration did not persist");

// --- 4. A browser enabled now must start with the configured set ------------
const { context: ctxB, page: pageB } = await launchProfile("chrome-profile-config-b");
await openSettingsPage(pageB);
await enableNotifications(pageB);
await pageB.waitForTimeout(1500);
const newDevice = await readDeviceTriggers(pageB);
const checked = (newDevice ?? []).filter((entry) => entry.checked);
console.log("new device triggers:", JSON.stringify(checked));
console.log(
  checked.length === 1 && checked[0]?.type === DECISION_TRIGGER
    ? "PASS: a newly enabled browser used the configured defaults"
    : "FAIL: a newly enabled browser did not use the configured defaults",
);

// --- 5. Restore -------------------------------------------------------------
for (const trigger of original.triggers) {
  await clickTrigger(pageA, trigger.type, trigger.checked);
}
await setSwitch(pageA, `[data-testid="${UNASSIGNED_TESTID}"]`, original.notifyUnassigned !== false);
await pageA.getByTestId("save-org-defaults").click();
await pageA.waitForTimeout(2500);
console.log("restored configuration:", JSON.stringify(await readOrgDefaults(pageA)));

await ctxB.close();
await ctxA.close();
console.log(`(company ${COMPANY_ID})`);
