/**
 * Local-only styling check: measure the host's Company Settings primitives and
 * the plugin settings page in the same browser, then report a property-by-property
 * diff plus a token check for the colours.
 *
 * A screenshot answers "does this look right" only for a human eye; this answers
 * it with numbers, which a reviewer can re-run.
 *
 * Two traps this avoids, both of which produced false diffs before:
 *   - unscoped selectors. `input` or `button[data-size]` also matches unrelated
 *     components on the page (the instance settings block wraps its fields in a
 *     bordered `px-4 py-4` box, so its inputs are 34px narrower, and it contains
 *     a `ghost` button that is not the `sm` size variant).
 *   - content-dependent properties. Width and height of a label or a section
 *     depend on the text and the number of children, not on styling.
 *
 * Usage: node scripts/compare-ui.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:3100";
const PREFIX = process.env.SPIKE_COMPANY_PREFIX ?? "ACME";
const PLUGIN_ID = process.env.SPIKE_PLUGIN_ID ?? "0fe68a3c-40db-4524-b94f-69ca8fc50231";
const CHROME = process.env.SPIKE_CHROME_PATH ?? "/opt/google/chrome-canary/google-chrome-canary";

const TEXT_PROPS = ["font-size", "line-height", "font-weight", "letter-spacing", "text-transform", "color"];
const CONTROL_PROPS = [
  "font-size",
  "line-height",
  "font-weight",
  "color",
  "background-color",
  "border-color",
  "border-width",
  "border-radius",
  "padding",
  "height",
];

/** name: { host, plugin, props } — host selector on /company/settings. */
const PAIRS = {
  "section block": {
    host: "div.max-w-2xl",
    plugin: ".pcp-section",
    props: ["max-width"],
  },
  "section label": {
    host: "div.max-w-2xl .text-xs.font-medium.text-muted-foreground.uppercase",
    plugin: ".pcp-section-label",
    props: TEXT_PROPS,
  },
  "field label": {
    host: "div.max-w-2xl label.text-xs.text-muted-foreground",
    plugin: ".pcp-field-label",
    props: TEXT_PROPS,
  },
  "text input": {
    host: "div.max-w-2xl input[type='text'].border-border",
    plugin: ".pcp-input",
    props: CONTROL_PROPS,
  },
  "sm button (destructive)": {
    host: "button[data-size='sm'][data-variant='destructive']",
    plugin: ".pcp-btn-destructive",
    props: ["font-size", "line-height", "font-weight", "border-radius", "padding", "height", "gap"],
  },
  switch: {
    host: "button[role='switch'][data-testid='company-settings-team-approval-toggle']",
    plugin: ".pcp-switch",
    props: ["width", "height", "border-radius", "border-width", "padding"],
  },
  "switch thumb": {
    host: "button[role='switch'][data-testid='company-settings-team-approval-toggle'] > span",
    plugin: ".pcp-switch-thumb",
    props: ["width", "height", "border-radius", "translate"],
  },
};

/** Each plugin element must resolve to the host token it is meant to use. */
const TOKENS = [
  { plugin: ".pcp-btn", property: "background-color", token: "--primary" },
  { plugin: ".pcp-btn", property: "color", token: "--primary-foreground" },
  { plugin: ".pcp-btn-outline", property: "background-color", token: "--background" },
  { plugin: ".pcp-btn-destructive", property: "background-color", token: "--destructive" },
  { plugin: ".pcp-input", property: "border-color", token: "--border" },
  { plugin: ".pcp-card", property: "background-color", token: "--card" },
  { plugin: ".pcp-card", property: "border-color", token: "--border" },
  { plugin: ".pcp-switch[aria-checked='true']", property: "background-color", token: "--status-task-done" },
  { plugin: ".pcp-switch:not([aria-checked='true'])", property: "background-color", token: null },
  { plugin: ".pcp-section-label", property: "color", token: "--muted-foreground" },
  { plugin: ".pcp-hint", property: "color", token: "--muted-foreground" },
];

/** `rounded-full` is Tailwind's `calc(infinity * 1px)`; a 9999px capsule is the same shape. */
function equivalent(property, host, plugin) {
  if (host === plugin) return true;
  if (property === "border-radius" && Number.parseFloat(host) > 1000 && Number.parseFloat(plugin) > 1000) {
    return true;
  }
  return false;
}

async function measure(page, pairs) {
  return page.evaluate(
    ({ pairs }) => {
      const out = {};
      for (const [name, { selector, props }] of Object.entries(pairs)) {
        const element = document.querySelector(selector);
        if (!element) {
          out[name] = null;
          continue;
        }
        const style = getComputedStyle(element);
        out[name] = Object.fromEntries(props.map((property) => [property, style.getPropertyValue(property)]));
      }
      return out;
    },
    { pairs },
  );
}

/**
 * Resolve `var(--token)` the way the page's own CSS would, by asking the browser
 * for an element painted with it — colour values round-trip through different
 * syntaxes (hex, oklch), so string comparison against the raw token would lie.
 */
async function checkTokens(page, tokens) {
  return page.evaluate((tokens) => {
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);

    const resolve = (token) => {
      probe.style.color = "";
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };

    const results = tokens.map(({ plugin, property, token }) => {
      const element = document.querySelector(plugin);
      if (!element) return { plugin, property, token, verdict: "element missing" };
      const actual = getComputedStyle(element).getPropertyValue(property);
      if (!token) return { plugin, property, token: "(off-state)", verdict: `= ${actual}` };
      const expected = resolve(token);
      return { plugin, property, token, expected, actual, verdict: expected === actual ? "match" : "MISMATCH" };
    });

    probe.remove();
    return results;
  }, tokens);
}

const context = await chromium.launchPersistentContext(".cache/chrome-profile-verify", {
  executablePath: CHROME,
  headless: true,
  permissions: ["notifications"],
  viewport: { width: 1440, height: 1100 },
});
const view = context.pages()[0] ?? (await context.newPage());

await view.goto(`${BASE}/${PREFIX}/company/settings`, { waitUntil: "domcontentloaded" });
await view.waitForTimeout(3500);
const host = await measure(
  view,
  Object.fromEntries(
    Object.entries(PAIRS).map(([name, { host, props }]) => [name, { selector: host, props }]),
  ),
);

await view.goto(`${BASE}/${PREFIX}/company/settings/instance/plugins/${PLUGIN_ID}`, {
  waitUntil: "domcontentloaded",
});
await view.locator('[data-testid="enable-notifications"]').waitFor({ timeout: 30000 });
await view.waitForTimeout(3000);
const plugin = await measure(
  view,
  Object.fromEntries(
    Object.entries(PAIRS).map(([name, { plugin, props }]) => [name, { selector: plugin, props }]),
  ),
);

let mismatches = 0;
for (const [name, { props }] of Object.entries(PAIRS)) {
  console.log(`\n== ${name}`);
  if (!host[name]) {
    console.log("   host element not found (skipped)");
    continue;
  }
  if (!plugin[name]) {
    console.log("   PLUGIN ELEMENT MISSING");
    mismatches += 1;
    continue;
  }
  for (const property of props) {
    const a = host[name][property];
    const b = plugin[name][property];
    const same = equivalent(property, a, b);
    if (!same) mismatches += 1;
    console.log(`   ${same ? "ok  " : "DIFF"} ${property.padEnd(17)} host=${a.padEnd(28)} plugin=${b}`);
  }
}

console.log("\n== colours come from the host's tokens");
for (const result of await checkTokens(view, TOKENS)) {
  if (result.verdict === "MISMATCH") mismatches += 1;
  const where = `${result.plugin} ${result.property}`.padEnd(46);
  console.log(
    `   ${result.verdict === "MISMATCH" ? "DIFF" : "ok  "} ${where} ${
      result.token ? `var(${result.token})` : result.token
    }${result.expected ? ` = ${result.expected}` : ""} → ${result.actual ?? result.verdict}`,
  );
}

await context.close();
console.log(`\n${mismatches === 0 ? "identical to the host's primitives" : `${mismatches} mismatch(es)`}`);
