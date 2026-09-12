/**
 * Shared helpers for the browser-driven end-to-end checks.
 *
 * These exist because three separate false alarms came from the same mistake:
 * treating "the page shows a registered device" as proof that *this* run
 * registered *this* browser. A stale device row from an earlier run satisfies
 * that condition instantly, so a failed registration or an early `enable()`
 * error looked like a delivery bug. Every check here asserts an outcome instead.
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

export const CHROME = process.env.SPIKE_CHROME_PATH ?? "/opt/google/chrome-canary/google-chrome-canary";

/**
 * The plugin's record id, which every settings URL needs.
 *
 * A local reinstall mints a new record, so a pinned default rots silently and
 * the check then browses a URL that no longer exists. Read what the instance
 * reports instead; `SPIKE_PLUGIN_ID` still wins when a check targets a specific
 * install.
 */
function pluginRecordId() {
  if (process.env.SPIKE_PLUGIN_ID) return process.env.SPIKE_PLUGIN_ID;
  const listing = execFileSync("paperclipai", ["plugin", "list"], { encoding: "utf8" });
  const match = /key=conreo\.webpush\b[^\n]*\bid=([0-9a-fA-F-]{36})/.exec(listing);
  if (!match) {
    throw new Error("Could not find an installed conreo.webpush plugin; set SPIKE_PLUGIN_ID.");
  }
  return match[1];
}

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
  return `${base}/${prefix}/company/settings/instance/plugins/${pluginRecordId()}`;
}

/** The host page this plugin's settings page is styled to match. */
export function companySettingsUrl() {
  const base = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
  const prefix = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
  return `${base}/${prefix}/company/settings`;
}

export async function openSettingsPage(page) {
  await page.goto(pluginSettingsUrl(), { waitUntil: "domcontentloaded" });
  // Wait on the page's own first control, not on a heading's wording: the layout
  // has been restyled more than once, and a helper that greps a title fails the
  // whole check when it changes.
  await page.locator('[data-testid="enable-notifications"]').waitFor({ timeout: 30000 });
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
        // Wait on state, not on wording. The success condition is *this*
        // browser's own device card, which is rendered only for the device whose
        // endpoint matches the subscription this page holds — text matching is
        // no good here, because the section is labelled "This browser" and its
        // description contains the word "registered" whether or not the
        // registration happened.
        if (document.querySelector('[data-testid="device-row"][data-device-current="true"]')) {
          return "success";
        }
        const text = document.body.innerText;
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

  // This card exists only for the device whose endpoint matches the subscription
  // held by this page, so it proves *this* run registered *this* browser rather
  // than reading a stale row.
  await page
    .locator('[data-testid="device-row"][data-device-current="true"]')
    .waitFor({ timeout: 20000 });
}

/**
 * Turn one trigger on or off for *this* browser's own device card.
 *
 * Scoped to the current device on purpose: the list may hold several devices,
 * and toggling a row belonging to another one would leave this browser
 * unsubscribed. The control is the host's switch, so the state lives in
 * `aria-checked` rather than in an input's `checked`.
 */
export async function setDeviceTrigger(page, eventType, enabled = true) {
  const testId = `device-trigger-${eventType}`;
  const toggle = page.locator(
    `[data-testid="device-row"][data-device-current="true"] [data-testid="${testId}"]`,
  );
  await toggle.waitFor({ timeout: 20000 });
  if (((await toggle.getAttribute("aria-checked")) === "true") === enabled) return false;

  await toggle.click();
  await page.waitForFunction(
    ({ testId, enabled }) => {
      const row = document.querySelector('[data-testid="device-row"][data-device-current="true"]');
      const match = row?.querySelector(`[data-testid="${testId}"]`);
      return Boolean(match) && (match.getAttribute("aria-checked") === "true") === enabled;
    },
    { testId, enabled },
    { timeout: 15000 },
  );
  return true;
}

/**
 * Wait until the plugin's registration is running the build the server serves.
 *
 * A changed `sw.js` does not take over by itself: the browser notices on an
 * update check, installs the new worker and only then activates it. Asking the
 * registration a question in that window reaches the *previous* build — which is
 * how a brand-new message type looked like it was being ignored when the old
 * worker answered what it knew.
 */
export async function settlePluginServiceWorker(page) {
  return page.evaluate(async () => {
    const find = async () => {
      const resource = performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => /\/_plugins\/[^/]+\/ui\//.test(name));
      const pluginId = resource ? /\/_plugins\/([^/]+)\/ui\//.exec(resource)[1] : null;
      const registrations = await navigator.serviceWorker.getRegistrations();
      const scoped = pluginId
        ? registrations.filter((item) => item.scope.includes(`/_plugins/${pluginId}/`))
        : [];
      return scoped[0] ?? registrations.find((item) => item.scope.includes("/_plugins/")) ?? null;
    };

    const registration = await find();
    if (!registration) return false;

    // A changed sw.js only takes over after an update check: without this the
    // question below reaches the previous build.
    await registration.update().catch(() => {});
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const current = await find();
      if (!current) return false;
      if (!current.installing && !current.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return true;
  });
}

/**
 * What the plugin's service worker last showed, straight from the worker.
 *
 * `getNotifications()` is the obvious probe and the wrong one: in a headless
 * browser it frequently reports nothing even when the push arrived and the
 * delivery ledger says `delivered`. The worker itself knows what it displayed, so
 * ask it — this is the only way to assert on the *text* a real event produced.
 */
export async function lastPushedMessage(page, { settle = true } = {}) {
  // Settling runs an update check, which is worth doing once before asking and
  // wasteful on every poll of a long wait.
  if (settle) await settlePluginServiceWorker(page);
  return page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/_plugins\/[^/]+\/ui\//.test(name));
    const pluginId = resource ? /\/_plugins\/([^/]+)\/ui\//.exec(resource)[1] : null;
    const registrations = await navigator.serviceWorker.getRegistrations();
    const scoped = pluginId
      ? registrations.filter((item) => item.scope.includes(`/_plugins/${pluginId}/`))
      : [];
    const registration = scoped[0] ?? registrations.find((item) => item.scope.includes("/_plugins/")) ?? null;
    if (!registration?.active) return { error: "no active plugin service worker" };

    const reply = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve({ error: "the worker did not reply" }), 5000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      registration.active.postMessage({ type: "last-push" }, [channel.port2]);
    });
    return reply;
  });
}

/**
 * Poll until the worker's last push matches.
 *
 * How long a push service takes to deliver is not under the plugin's control, and
 * a cold subscription has been observed to take minutes, so the caller sets a
 * generous window and should assert on `payload.at` too: the worker's record
 * survives between runs, and a match on an old message would report a pass that
 * this run never earned.
 */
export async function waitForPushedMessage(page, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let first = true;
  while (Date.now() < deadline) {
    last = await lastPushedMessage(page, { settle: first });
    first = false;
    const payload = last?.payload;
    if (payload && predicate(payload)) return payload;
    await page.waitForTimeout(2000);
  }
  return { miss: true, last };
}

/**
 * Open one trigger's editor in the notification content list.
 *
 * The section is an accordion — a row per trigger, one editor open at a time — so a
 * check that reaches straight for a title field finds nothing until the row is open.
 * Idempotent, because a check may call it again after a reload.
 */
export async function openTriggerEditor(page, eventType) {
  const row = page.getByTestId(`open-${eventType}`);
  await row.waitFor({ timeout: 20000 });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await page.locator(`[data-testid="template-title-${eventType}"]`).waitFor({ timeout: 20000 });
}

/**
 * The delivery ledger rows shown for this browser's own device.
 *
 * Read after a reload: the settings page fetches the device list when it loads and
 * after its own actions, not continuously, so a delivery that happens while the
 * page sits open is not visible until the list is fetched again.
 */
export async function deviceLedger(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="device-row"][data-device-current="true"]');
    return {
      last: row?.querySelector(".pcp-hint")?.textContent?.trim() ?? null,
      deliveries: [...(row?.querySelectorAll(".pcp-list li") ?? [])].map((li) => li.textContent.trim()),
    };
  });
}

/** Read (and optionally clear) the notifications this origin has shown. */
export async function readNotifications(page, { clear = false } = {}) {
  return page.evaluate(async (shouldClear) => {
    const resource = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/_plugins\/[^/]+\/ui\//.test(name));
    const pluginId = resource ? /\/_plugins\/([^/]+)\/ui\//.exec(resource)[1] : null;
    const registrations = await navigator.serviceWorker.getRegistrations();
    const scoped = pluginId
      ? registrations.filter((item) => item.scope.includes(`/_plugins/${pluginId}/`))
      : [];
    const pluginRegistration =
      scoped[0] ?? registrations.find((item) => item.scope.includes("/_plugins/")) ?? null;
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
    const resource = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/_plugins\/[^/]+\/ui\//.test(name));
    const pluginId = resource ? /\/_plugins\/([^/]+)\/ui\//.exec(resource)[1] : null;
    const registrations = await navigator.serviceWorker.getRegistrations();
    const scoped = pluginId
      ? registrations.filter((item) => item.scope.includes(`/_plugins/${pluginId}/`))
      : [];
    const pluginRegistration =
      scoped[0] ?? registrations.find((item) => item.scope.includes("/_plugins/")) ?? null;
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
