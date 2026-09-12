import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Capabilities are declared in full, up front, on purpose: the host marks a
 * plugin `upgrade_pending` and requires explicit operator approval whenever an
 * upgrade *adds* capabilities, so widening this list later would turn every
 * version bump into an approval prompt.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "conreo.webpush",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Web Push Notifications",
  description: "Desktop and Android push notifications for Paperclip board events.",
  author: "conreo",
  categories: ["automation"],
  capabilities: [
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
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    // The host derives the schema as `plugin_<namespaceSlug>_<sha256(manifest.id)[0:10]>`
    // and requires every migration object to be fully qualified with it, so the
    // resolved name (`plugin_webpush_7d3a6286ba`) is hardcoded in the migration SQL.
    // Both the slug and the plugin id are therefore frozen: changing either one
    // points the plugin at a different, empty schema.
    namespaceSlug: "webpush",
    migrationsDir: "migrations",
  },
  jobs: [
    {
      jobKey: "prune-subscriptions",
      displayName: "Prune dead push subscriptions",
      description: "Removes subscriptions whose push endpoint is permanently gone.",
      schedule: "0 4 * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "notifications",
        displayName: "Notifications",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
