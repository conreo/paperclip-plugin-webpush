import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_STYLES, usePluginStyles } from "../src/ui/styles.js";

const uiDir = fileURLToPath(new URL("../src/ui/", import.meta.url));
const sources = ["SettingsPage.tsx", "FullscreenButton.tsx"].map((name) => ({
  name,
  text: readFileSync(`${uiDir}${name}`, "utf8"),
}));

/** Every `pcp-*` class named in the UI sources. */
function classesUsedInSources(): Set<string> {
  const used = new Set<string>();
  for (const source of sources) {
    for (const match of source.text.matchAll(/["'` ](pcp-[a-z0-9-]+)/g)) used.add(match[1]);
  }
  return used;
}

describe("plugin stylesheet", () => {
  it("defines every class the UI asks for", () => {
    // A typo here renders an unstyled native control, which is invisible in a
    // unit test but obvious on the page — so assert the names line up.
    const used = classesUsedInSources();
    expect(used.size).toBeGreaterThan(8);

    const missing = [...used].filter((name) => !PLUGIN_STYLES.includes(`.${name}`));
    expect(missing).toEqual([]);
  });

  it("defines nothing the UI no longer uses", () => {
    // The reverse direction: when the editor replaced the page's text inputs,
    // the `.pcp-input` rules were left behind pointing at nothing. Dead CSS is
    // how a stylesheet drifts away from what is on screen.
    const sources = ["SettingsPage.tsx", "TemplateEditor.tsx", "FullscreenButton.tsx"]
      .map((name) => readFileSync(`${uiDir}${name}`, "utf8"))
      .join("\n");

    const defined = new Set(
      [...PLUGIN_STYLES.matchAll(/\.(pcp-[a-z0-9-]+)/g)].map((match) => match[1]),
    );
    const unused = [...defined].filter((name) => !sources.includes(name));
    expect(unused).toEqual([]);
  });

  it("draws the host's switch: green capsule with an oblong thumb", () => {
    // Values taken from the host's ToggleSwitch; the previous hand-rolled pill
    // was the app's second switch implementation, which this replaces.
    expect(PLUGIN_STYLES).toMatch(
      /\.pcp-switch\[aria-checked="true"\]\s*\{[^}]*background:\s*var\(--status-task-done\)/,
    );
    expect(PLUGIN_STYLES).toMatch(/\.pcp-switch-thumb\s*\{[^}]*height:\s*1rem/);
    expect(PLUGIN_STYLES).toMatch(/\.pcp-switch-thumb\s*\{[^}]*width:\s*1\.5rem/);
    // The host's `translate-x-4` moves the thumb with the individual `translate`
    // property, not `transform`; matching it keeps the two switches identical.
    expect(PLUGIN_STYLES).toMatch(
      /\.pcp-switch\[aria-checked="true"\]\s+\.pcp-switch-thumb\s*\{[^}]*translate:\s*1rem 0/,
    );
  });

  it("sets the line-height of every text size, as Tailwind's text-* utilities do", () => {
    // `text-xs` is 0.75rem/1rem and `text-sm` is 0.875rem/1.25rem; omitting the
    // line-height leaves controls a pixel or two taller than the host's.
    for (const rule of [
      /\.pcp-hint\s*\{[^}]*font-size:\s*0\.75rem; line-height:\s*1rem/,
      /\.pcp-field-label\s*\{[^}]*font-size:\s*0\.75rem; line-height:\s*1rem/,
      /\.pcp-editor-field\s*\{[^}]*font-size:\s*0\.875rem; line-height:\s*1\.25rem/,
      /\.pcp-btn\s*\{[^}]*font-size:\s*0\.875rem; line-height:\s*1\.25rem/,
    ]) {
      expect(PLUGIN_STYLES).toMatch(rule);
    }
  });

  it("takes its colours from the host's tokens", () => {
    for (const token of [
      "--card",
      "--border",
      "--primary",
      "--primary-foreground",
      "--muted-foreground",
      "--destructive",
      "--ring",
      "--radius-md",
      "--radius-lg",
    ]) {
      expect(PLUGIN_STYLES).toContain(`var(${token})`);
    }
    // No raw palette values: the only literal colour is the button's white text,
    // which the host itself spells `text-white` on the destructive variant.
    const hexes = [...PLUGIN_STYLES.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
    expect(hexes).toEqual(["#fff"]);
  });

  it("does nothing without a document, so the module is importable outside a browser", () => {
    expect(() => usePluginStyles()).not.toThrow();
  });
});
