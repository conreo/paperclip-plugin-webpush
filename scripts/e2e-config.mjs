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
 * Usage: node scripts/e2e-config.mjs
 */
import {
  enableNotifications,
  launchProfile,
  openSettingsPage,
  pluginSettingsUrl,
} from "./lib/browser.mjs";

const COMPANY_ID = process.env.SPIKE_COMPANY_ID ?? "acme-company-id";

/** Read the "Organization defaults" section: trigger checkboxes and the toggle. */
const readOrgDefaults = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('[data-testid="org-defaults"]');
    if (!section) return null;
    const triggers = [...section.querySelectorAll("label")]
      .filter((label) => !label.querySelector('input[data-testid="notify-unassigned"]'))
      .map((label) => ({
        label: label.textContent?.trim() ?? "",
        checked: label.querySelector("input")?.checked ?? false,
      }));
    const unassigned = section.querySelector('input[data-testid="notify-unassigned"]');
    return { triggers, notifyUnassigned: unassigned?.checked ?? null };
  });

const readDeviceTriggers = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('[data-testid="device-row"][data-device-current="true"]');
    if (!row) return null;
    return [...row.querySelectorAll("label")].map((label) => ({
      label: label.textContent?.trim() ?? "",
      checked: label.querySelector("input")?.checked ?? false,
    }));
  });

const clickTrigger = async (page, wantedLabel, wanted) => {
  await page.evaluate(
    ({ wantedLabel, wanted }) => {
      const section = document.querySelector('[data-testid="org-defaults"]');
      const label = [...(section?.querySelectorAll("label") ?? [])].find(
        (candidate) =>
          (candidate.textContent ?? "").includes(wantedLabel) &&
          !candidate.querySelector('input[data-testid="notify-unassigned"]'),
      );
      const input = label?.querySelector("input");
      if (input && input.checked !== wanted) input.click();
    },
    { wantedLabel, wanted },
  );
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
const DECISION = "decisions desk needs a choice";
const APPROVAL = "approval is waiting for a decision";

for (const trigger of original.triggers) {
  const keep = trigger.label.includes(DECISION);
  await clickTrigger(pageA, trigger.label, keep);
}
await pageA.evaluate(() => {
  const input = document.querySelector('input[data-testid="notify-unassigned"]');
  if (input instanceof HTMLInputElement && input.checked) input.click();
});

await pageA.getByTestId("save-org-defaults").click();
const notice = await pageA
  .waitForFunction(
    () => {
      const text = document.body.innerText;
      if (/Saved\. A browser enabled from now on/.test(text)) return "saved";
      const failure = /Only an instance admin[^\n]*|Save failed[^\n]*/.exec(text);
      return failure ? `error: ${failure[0]}` : null;
    },
    null,
    { timeout: 20000 },
  )
  .then((handle) => handle.jsonValue())
  .catch(() => "timeout waiting for a save outcome");
console.log("save outcome:", notice);
if (notice !== "saved") {
  await ctxA.close();
  throw new Error(`configuration did not save → ${notice}`);
}

// --- 3. Reload: the rendered values must come from storage ------------------
await pageA.reload({ waitUntil: "domcontentloaded" });
await pageA.getByRole("heading", { name: "Notifications on this browser" }).waitFor({ timeout: 30000 });
await pageA.waitForTimeout(2500);
const afterReload = await readOrgDefaults(pageA);
console.log("after reload:", JSON.stringify(afterReload));

const persisted =
  afterReload?.notifyUnassigned === false &&
  afterReload.triggers.filter((t) => t.checked).length === 1 &&
  afterReload.triggers.some((t) => t.checked && t.label.includes(DECISION));
console.log(persisted ? "PASS: the saved configuration survived a reload" : "FAIL: configuration did not persist");

// --- 4. A browser enabled now must start with the configured set ------------
const { context: ctxB, page: pageB } = await launchProfile("chrome-profile-config-b");
await pageB.goto(pluginSettingsUrl(), { waitUntil: "domcontentloaded" });
await pageB.getByRole("heading", { name: "Notifications on this browser" }).waitFor({ timeout: 30000 });
await enableNotifications(pageB);
await pageB.waitForTimeout(1500);
const newDevice = await readDeviceTriggers(pageB);
const checked = (newDevice ?? []).filter((entry) => entry.checked);
console.log("new device triggers:", JSON.stringify(checked));
console.log(
  checked.length === 1 && checked[0]?.label.includes(DECISION)
    ? "PASS: a newly enabled browser used the configured defaults"
    : "FAIL: a newly enabled browser did not use the configured defaults",
);

// --- 5. Restore -------------------------------------------------------------
if (original) {
  for (const trigger of original.triggers) {
    await clickTrigger(pageA, trigger.label, trigger.checked);
  }
  if (original.notifyUnassigned) {
    await pageA.evaluate(() => {
      const input = document.querySelector('input[data-testid="notify-unassigned"]');
      if (input instanceof HTMLInputElement && !input.checked) input.click();
    });
  }
  await pageA.getByTestId("save-org-defaults").click();
  await pageA.waitForTimeout(2500);
  const restored = await readOrgDefaults(pageA);
  console.log("restored configuration:", JSON.stringify(restored));
}

await ctxB.close();
await ctxA.close();
console.log(`(company ${COMPANY_ID})`);
