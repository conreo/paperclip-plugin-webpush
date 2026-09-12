/**
 * Notification editor check.
 *
 * The editor is where a message is composed out of text and objects, so this
 * proves the three claims it makes:
 *
 *   1. an object can be inserted without typing braces, and the preview shows
 *      the message that will be sent,
 *   2. objects can be reordered with a click, and the preview follows,
 *   3. what is saved survives a reload — and a real event then arrives with that
 *      exact wording, which is the only proof that the storage format is read
 *      correctly by the worker.
 *
 * It restores the trigger's wording at the end.
 *
 * Usage: node scripts/e2e-template.mjs
 */
import { execFileSync } from "node:child_process";
import {
  enableNotifications,
  launchProfile,
  openSettingsPage,
  pluginSettingsUrl,
  waitForPushedMessage,
} from "./lib/browser.mjs";

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
const PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
const COMPANY_ID = process.env.SPIKE_COMPANY_ID ?? "acme-company-id";

const TRIGGER = "approval.created";
const TITLE_FIELD = `template-title-${TRIGGER}`;

const cli = (...args) =>
  execFileSync("paperclipai", [...args, "--api-base", BASE], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: ".cache/npm" },
  });

const fieldValue = (page, testId) =>
  page.evaluate((id) => {
    const field = document.querySelector(`[data-testid="${id}"]`);
    if (!field) return null;
    // Read the field the way it is stored: object chips serialise to {{name}}.
    return [...field.childNodes]
      .map((node) =>
        node.nodeType === Node.TEXT_NODE
          ? (node.textContent ?? "")
          : node instanceof HTMLElement && node.dataset.object
            ? `{{${node.dataset.object}}}`
            : (node.textContent ?? ""),
      )
      .join("");
  }, testId);

const previewText = (page, kind) =>
  page.locator(`[data-testid="preview-${kind}-${TRIGGER}"]`).innerText();

/** Insert one object through the insert list, the way an operator would. */
async function insertObject(page, testId, object) {
  await page.locator(`[data-testid="${testId}"]`).click();
  await page.getByTestId(`${testId}-insert`).click();
  await page.getByTestId(`${testId}-object-${object}`).click();
}

const { context, page } = await launchProfile("chrome-profile-template");
await openSettingsPage(page);
await enableNotifications(page);

// --- 1. Compose a message out of objects and text ---------------------------
// Start from the built-in wording so the assertions do not depend on whatever a
// previous run left behind.
const reset = page.getByTestId(`reset-${TRIGGER}`);
if (await reset.count()) {
  await reset.click();
  await page.waitForTimeout(500);
}

await insertObject(page, TITLE_FIELD, "org");
await page.locator(`[data-testid="${TITLE_FIELD}"]`).click();
await page.keyboard.type(" needs ");
await insertObject(page, TITLE_FIELD, "type");

const composed = await fieldValue(page, TITLE_FIELD);
console.log("composed title:", JSON.stringify(composed));
const organisationName = (await previewText(page, "title")).replace(/ needs hire agent$/, "");
const expectedComposed = "{{org}} needs {{type}}";
const composedOk = composed === expectedComposed;
console.log(
  composedOk
    ? `PASS: objects inserted without typing braces (${expectedComposed})`
    : `FAIL: field holds ${JSON.stringify(composed)}`,
);

const previewBefore = await previewText(page, "title");
console.log("preview:", JSON.stringify(previewBefore));
const previewOk = previewBefore === `${organisationName} needs hire agent`;
console.log(
  previewOk
    ? "PASS: the preview shows the message with its objects filled in"
    : `FAIL: preview reads ${JSON.stringify(previewBefore)}`,
);

// --- 2. Reorder: the objects swap, the words stay put ------------------------
await page.locator(`[data-testid="${TITLE_FIELD}"] .pcp-object[data-object="type"] .pcp-object-tool[data-action="left"]`).click();
await page.waitForTimeout(300);

const reordered = await fieldValue(page, TITLE_FIELD);
const previewAfter = await previewText(page, "title");
console.log("reordered title:", JSON.stringify(reordered), "→ preview:", JSON.stringify(previewAfter));
const orderOk = reordered === "{{type}} needs {{org}}" && previewAfter === `hire agent needs ${organisationName}`;
console.log(
  orderOk
    ? "PASS: reordering swapped the objects and kept the words between them"
    : "FAIL: reordering did not produce {{type}} needs {{org}}",
);

if (!composedOk || !previewOk || !orderOk) {
  await context.close();
  process.exit(1);
}

// --- 3. Save, reload, and confirm the same message comes back ---------------
await page.getByTestId("save-notification-content").click();
const saved = await page
  .locator('[data-testid="config-notice"], [data-testid="config-error"]')
  .first()
  .innerText()
  .catch(() => "(no save outcome)");
console.log("save outcome:", saved.trim());
if (/failed|admin/i.test(saved)) {
  await context.close();
  process.exit(1);
}

await page.goto(pluginSettingsUrl(), { waitUntil: "domcontentloaded" });
await page.locator('[data-testid="enable-notifications"]').waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);

const afterReload = await fieldValue(page, TITLE_FIELD);
const reloadOk = afterReload === "{{type}} needs {{org}}";
console.log(
  reloadOk
    ? "PASS: the composed message survived a reload"
    : `FAIL: after reload the field holds ${JSON.stringify(afterReload)}`,
);

// --- 4. The stored configuration holds exactly that message ---------------
const stored = JSON.parse(
  cli("plugin", "config", "conreo.webpush", "-C", COMPANY_ID, "--json"),
).configJson.templates?.[TRIGGER]?.title;
console.log("stored title:", JSON.stringify(stored));
console.log(
  stored === "{{type}} needs {{org}}"
    ? "PASS: the composed message is what was stored"
    : `FAIL: storage holds ${JSON.stringify(stored)}`,
);

// --- 5. A real event must arrive with that wording -------------------------
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
      JSON.stringify({ reason: "webpush template e2e", agentName: "[webpush e2e] safe to reject" }),
      "--json",
    ),
  );
  approvalId = created.id ?? created.approval?.id ?? null;
  console.log(`created approval ${approvalId}`);

  const expectedTitle = `hire agent needs ${organisationName}`;
  // Generous: how long a push service takes to deliver is not under the plugin's
  // control, and a cold subscription has been observed to take tens of seconds.
  const pushed = await waitForPushedMessage(page, (payload) => payload.title === expectedTitle, 90000);
  console.log(
    pushed.miss
      ? `FAIL: the worker last showed ${JSON.stringify(pushed.last)} instead of ${JSON.stringify(expectedTitle)}`
      : `PASS: the notification arrived as composed → ${JSON.stringify(pushed.title)}`,
  );
  if (pushed.miss) process.exitCode = 1;
} finally {
  if (approvalId) {
    try {
      cli("approval", "reject", approvalId, "--decision-note", "webpush e2e cleanup");
      console.log("rejected the test approval");
    } catch (error) {
      console.log(`could not reject ${approvalId}: ${String(error).slice(0, 120)}`);
    }
  }
}

// --- 6. Restore the built-in wording ---------------------------------------
await page.getByTestId(`reset-${TRIGGER}`).click().catch(() => {});
await page.waitForTimeout(500);
await page.getByTestId("save-notification-content").click();
await page.waitForTimeout(1500);
console.log("restored the built-in wording");

await context.close();
console.log(`(company ${COMPANY_ID}, prefix ${PREFIX})`);
