/**
 * Shared helpers for the browser-driven end-to-end checks.
 *
 * These exist because three separate false alarms came from the same mistake:
 * treating "the page shows a registered device" as proof that *this* run
 * registered *this* browser. A stale device row from an earlier run satisfies
 * that condition instantly, so a failed registration or an early `enable()`
 * error looked like a delivery bug. Every check here asserts an outcome instead.
 */
import { chromium } from "playwright";

export const CHROME = process.env.SPIKE_CHROME_PATH ?? "/opt/google/chrome-canary/google-chrome-canary";

/**
 * A persistent profile is required: Chrome disables the Push API in incognito
 * contexts, which is what `browser.newContext()` creates. Each check gets its
 * own profile so one check's deliveries cannot throttle another's.
 */
export async function launchProfile(profileName) {
  const userDataDir = process.env.SPIKE_PROFILE_DIR ?? `.cache/${profileName}`;
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    permissions: ["notifications"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

export function pluginSettingsUrl() {
  const base = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
  const prefix = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
  const pluginId = process.env.SPIKE_PLUGIN_ID ?? "0fe68a3c-40db-4524-b94f-69ca8fc50231";
  return `${base}/${prefix}/company/settings/instance/plugins/${pluginId}`;
}

export async function openSettingsPage(page) {
  await page.goto(pluginSettingsUrl(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Notifications on this browser" }).waitFor({ timeout: 30000 });
}

/**
 * Click Enable/Re-register and require a real outcome.
 *
 * Waits for the button to become enabled (it is disabled until the plugin's
 * client config arrives), clicks, then insists on the success notice before
 * returning. Any error text the settings page renders is surfaced instead of
 * being swallowed.
 */
export async function enableNotifications(page) {
  const button = page.getByRole("button", {
    name: /Enable notifications|Re-register this browser/,
  });
  await button.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () => {
      const match = [...document.querySelectorAll("button")].find((candidate) =>
        /Enable notifications|Re-register this browser/.test(candidate.textContent ?? ""),
      );
      return Boolean(match && !match.disabled);
    },
    null,
    { timeout: 30000 },
  );

  await button.click();

  const outcome = await page
    .waitForFunction(
      () => {
        const text = document.body.innerText;
        // Wait on state, not on wording: the copy changed once already, and a
        // helper that greps a sentence fails the whole suite when it does.
        const registered =
          /registered/.test(text) ||
          Boolean(document.querySelector('[data-testid="device-row"][data-device-current="true"]'));
        if (registered) return "success";
        const failure =
          /Notifications are blocked[^\n]*|Web Push needs[^\n]*|This browser does not support[^\n]*|Registration failed[^\n]*|Plugin configuration is still loading[^\n]*|A signed-in board user[^\n]*|A valid push subscription[^\n]*/.exec(
            text,
          );
        return failure ? `error: ${failure[0]}` : null;
      },
      null,
      { timeout: 45000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => "timeout waiting for a registration outcome");

  if (outcome !== "success") {
    const panel = await page
      .locator("main, [role=main], body")
      .first()
      .innerText()
      .catch(() => "(page text unavailable)");
    throw new Error(
      `enabling notifications did not succeed → ${outcome}\n--- settings page as rendered ---\n${panel.slice(0, 1200)}`,
    );
  }

  // "This browser" is rendered only for the device whose endpoint matches the
  // subscription held by this page, so it proves *this* run registered *this*
  // browser rather than reading a stale row.
  await page.getByText("This browser").first().waitFor({ timeout: 20000 });
}

/** Read (and optionally clear) the notifications this origin has shown. */
export async function readNotifications(page, { clear = false } = {}) {
  return page.evaluate(async (shouldClear) => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
    const notifications = (await pluginRegistration?.getNotifications()) ?? [];
    const mapped = notifications.map((item) => ({
      title: item.title,
      body: item.body,
      tag: item.tag,
      url: item.data?.url ?? null,
    }));
    if (shouldClear) for (const notification of notifications) notification.close();
    return mapped;
  }, clear);
}

export async function currentEndpoint(page) {
  return page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const pluginRegistration = registrations.find((item) => item.scope.includes("/_plugins/"));
    const subscription = await pluginRegistration?.pushManager.getSubscription();
    return {
      endpoint: subscription?.endpoint ?? null,
      registrationCount: registrations.length,
      scopes: registrations.map((item) => item.scope),
    };
  });
}

/** Poll until a notification matching the predicate appears, or time out. */
export async function waitForNotification(page, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notifications = await readNotifications(page);
    const match = notifications.find((item) => predicate(item));
    if (match) return match;
    await page.waitForTimeout(750);
  }
  return null;
}

/**
 * On a miss, report *why* — most often the plugin's own flood control, which is
 * working as designed and would otherwise look like a broken pipeline.
 */
export async function explainMiss(page) {
  const panel = await page
    .locator("section", { hasText: "Registered devices" })
    .last()
    .innerText();
  const throttled = /throttled/.test(panel);
  return {
    throttled,
    hint: throttled
      ? "the device hit the per-device throttle (recorded as `throttled`); wait 5 minutes or use a fresh SPIKE_PROFILE_DIR"
      : "no delivery row for this event — the worker found no matching recipient",
    panel: panel.slice(0, 700),
  };
}
