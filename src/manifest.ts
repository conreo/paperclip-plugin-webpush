import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_EVENT_TYPES, NOTIFIABLE_EVENT_TYPES } from "./notifications.js";

/**
 * Capabilities are declared in full, up front, on purpose: the host marks a
 * plugin `upgrade_pending` and requires explicit operator approval whenever an
 * upgrade *adds* capabilities, so widening this list later would turn every
 * version bump into an approval prompt.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "conreo.webpush",
  apiVersion: 1,
  version: "0.9.2",
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
    // Resolves the display name of the agent a notification is about.
    "agents.read",
    // Resolves which humans belong to the event's company, so an unassigned event
    // reaches that company's members instead of whichever devices were registered
    // from it.
    "access.members.read",
    "instance.settings.register",
    // Renders the fullscreen toolbar button.
    "ui.action.register",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  /**
   * Company-scoped operator configuration.
   *
   * The host validates saved values against this schema, and its config API is
   * instance-admin gated, which is what makes these settings safe to store there
   * rather than in plugin state. The host's generated config form is not used:
   * a plugin with a custom settings page does not get it rendered, so this
   * plugin's own page edits these values.
   */
  instanceConfigSchema: {
    type: "object",
    properties: {
      defaultTriggers: {
        type: "array",
        title: "Triggers for newly enabled browsers",
        description:
          "Which notifications a browser starts with when someone clicks Enable notifications. Each device can still change this afterwards.",
        items: { type: "string", enum: [...NOTIFIABLE_EVENT_TYPES] },
        default: [...DEFAULT_EVENT_TYPES],
        uniqueItems: true,
      },
      organizationLabel: {
        type: "string",
        title: "Organization name in notifications",
        description:
          "Shown in notification titles. Leave empty to use the organization's own name.",
      },
      includeAgentName: {
        type: "boolean",
        title: "Include the agent's name",
        description:
          "Name the agent in notifications that are about one, such as a failed run or an approval an agent requested. Applies to every notification type.",
        default: true,
      },
      includeOrganizationLabel: {
        type: "boolean",
        title: "Show the organization name",
        description:
          "Prefix notification titles with the organization name, so a notification is attributable when several organizations are in play.",
        default: true,
      },
      templates: {
        type: "object",
        title: "Notification text",
        description:
          "Optional wording per notification. Use {{org}}, {{identifier}}, {{title}}, {{type}}, {{scope}} or {{run}} where they apply. Leave a field empty to keep the built-in wording.",
        additionalProperties: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      notifyUnassignedEvents: {
        type: "boolean",
        title: "Notify about events that name nobody responsible",
        description:
          "When off, only events that name a responsible user notify anyone. Unassigned events, such as a budget incident with no owner, notify nobody.",
        default: true,
      },
    },
    additionalProperties: false,
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
      {
        // Immersive fullscreen for deployments that cannot be installed as an
        // app (a tailnet-only or other private origin cannot mint a WebAPK), so
        // the address bar is still removable on demand.
        type: "globalToolbarButton",
        id: "fullscreen",
        displayName: "Fullscreen",
        exportName: "FullscreenButton",
      },
    ],
  },
};

export default manifest;
