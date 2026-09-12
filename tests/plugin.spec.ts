import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

const swSource = readFileSync(fileURLToPath(new URL("../src/ui/sw.js", import.meta.url)), "utf8");

describe("plugin manifest", () => {
  it("declares the plugin API version the host requires", () => {
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.id).toMatch(/^[a-z0-9._-]+$/);
  });

  it("declares every capability the worker's host calls need", () => {
    // events.on, ctx.db, ctx.http, ctx.jobs, ctx.state, companies, settings page, secrets.
    for (const capability of [
      "events.subscribe",
      "jobs.schedule",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "http.outbound",
      "companies.read",
      "instance.settings.register",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
    ]) {
      expect(manifest.capabilities).toContain(capability);
    }
  });

  it("points entrypoints at built output and ships a settings page", () => {
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.entrypoints.ui).toBe("./dist/ui");
    expect(manifest.ui?.slots?.[0]).toMatchObject({
      type: "settingsPage",
      exportName: "SettingsPage",
    });
  });
});

describe("push service worker", () => {
  it("handles push and notification clicks", () => {
    expect(swSource).toContain('addEventListener("push"');
    expect(swSource).toContain("showNotification");
    expect(swSource).toContain('addEventListener("notificationclick"');
    expect(swSource).toContain("openWindow");
  });

  it("never intercepts fetch, so it cannot interfere with the app's root worker", () => {
    // The app registers its own root-scoped /sw.js for offline fallback. This
    // worker lives under /_plugins/<id>/ui/ and must stay a pure push receiver.
    expect(swSource).not.toContain('addEventListener("fetch"');
  });
});
