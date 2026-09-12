import { useCallback, useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  SAMPLE_AGENT_NAME,
  hasUnknownPlaceholder,
  previewDefaults,
  renderTemplate,
  sampleTemplateVars,
  templateObjectsFor,
  type NotifiableEventType,
} from "../notifications.js";
import { TemplateEditor } from "./TemplateEditor.js";
import { usePluginStyles } from "./styles.js";

type EventTypeOption = { type: string; label: string; defaultEnabled: boolean };
type NotificationTemplate = { title?: string; body?: string };
type ClientConfig = {
  vapidPublicKey: string;
  eventTypes: EventTypeOption[];
  notifyUnassignedEvents: boolean;
  /** The organization's own name: what the built-in wording prefixes, and the preview's sample. */
  organizationName: string | null;
  templates: Record<string, NotificationTemplate>;
  throttle: { max: number; windowMinutes: number };
};
type Delivery = {
  eventType: string;
  status: string;
  httpStatus: number | null;
  error: string | null;
  createdAt: string;
};
type Device = {
  endpoint: string;
  eventTypes: string[];
  enabled: boolean;
  origin: string | null;
  deliveries: Delivery[];
};
type DevicesResult = { devices: Device[] };
type TestResult = DevicesResult & {
  results: { endpoint: string; ok: boolean; statusCode?: number; error?: string }[];
};

const PLUGIN_ID = "conreo.webpush";

/**
 * The plugin UI is served from `/_plugins/<pluginId>/ui/`, and the host may use
 * either the plugin's record id or its key in that path. Deriving the base from
 * the URL this bundle was actually loaded from avoids hardcoding the wrong one.
 */
function pluginUiBase(): string {
  const fallback = `/_plugins/${PLUGIN_ID}/ui/`;
  if (typeof performance === "undefined") return fallback;
  for (const entry of performance.getEntriesByType("resource")) {
    const match = /^(.*\/_plugins\/[^/]+\/ui\/)/.exec(entry.name);
    if (match) return match[1];
  }
  return fallback;
}

/** The config API is addressed by record id, which only the bundle URL reveals. */
function pluginRecordId(): string | null {
  return /\/_plugins\/([^/]+)\//.exec(pluginUiBase())?.[1] ?? null;
}

/** `applicationServerKey` wants raw bytes; the VAPID key is base64url. */
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  // Allocate through an explicit ArrayBuffer: `applicationServerKey` is typed as
  // BufferSource, which excludes SharedArrayBuffer-backed views.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function deviceLabel(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(agent)) return "Android device";
  if (/iPhone|iPad/i.test(agent)) return "iOS device";
  if (/Macintosh/i.test(agent)) return "Mac";
  if (/Windows/i.test(agent)) return "Windows PC";
  if (/Linux/i.test(agent)) return "Linux device";
  return "This browser";
}

function endpointTail(endpoint: string): string {
  return endpoint.length > 28 ? `…${endpoint.slice(-24)}` : endpoint;
}

/**
 * Layout and controls follow the host's Company Settings page: a `max-w-6xl`
 * column, an icon-and-title header, then `max-w-2xl` sections introduced by an
 * uppercase muted label with their controls in a `space-y-3` stack. The classes
 * come from the plugin's own stylesheet (see `styles.ts`) because the plugin UI
 * may not import host components.
 */
function Section({
  label,
  children,
  testId,
  danger,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
  danger?: boolean;
}) {
  return (
    <section className="pcp-section" data-testid={testId}>
      <div className={danger ? "pcp-section-label-danger" : "pcp-section-label"}>{label}</div>
      <div className="pcp-stack">{children}</div>
    </section>
  );
}

/** The plugin's mark, used in the page header and as the preview's app icon. */
function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </svg>
  );
}

/** A labelled field for a custom control, which must not be a `<label>` (see the editor). */
function EditorField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pcp-field">
      <span className="pcp-field-label">{label}</span>
      {children}
    </div>
  );
}

/** The host's ToggleSwitch: a switch, not a checkbox. */
function Switch({
  checked,
  disabled,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="pcp-switch"
    >
      <span className="pcp-switch-thumb" />
    </button>
  );
}

/** A switch with its label on the left, matching the host's `ToggleField`. */
function ToggleField({
  label,
  hint,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <div className="pcp-toggle-row" title={hint}>
      <span className="pcp-toggle-label">{label}</span>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} testId={testId} />
    </div>
  );
}

export function SettingsPage(props: PluginSettingsPageProps) {
  usePluginStyles();

  const { data: config } = usePluginData<ClientConfig>("client-config");
  const registerSubscription = usePluginAction("register-subscription");
  const updateSubscription = usePluginAction("update-subscription");
  const removeDevice = usePluginAction("remove-device");
  const listDevices = usePluginAction("list-devices");
  const sendTest = usePluginAction("send-test");

  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [permission, setPermission] = useState<string>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);

  const [defaultTriggers, setDefaultTriggers] = useState<string[] | null>(null);
  const [notifyUnassigned, setNotifyUnassigned] = useState<boolean | null>(null);
  const [templates, setTemplates] = useState<Record<string, NotificationTemplate> | null>(null);
  // Which trigger's editor is open. One at a time: the section is a list to scan,
  // and two open editors at once is the wall of fields this replaced.
  const [openTrigger, setOpenTrigger] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const swSupported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const pushSupported = typeof window !== "undefined" && "PushManager" in window;

  // Seed the editable draft from what the worker reports as saved.
  useEffect(() => {
    if (!config) return;
    setDefaultTriggers(
      (current) => current ?? config.eventTypes.filter((option) => option.defaultEnabled).map((option) => option.type),
    );
    setNotifyUnassigned((current) => current ?? config.notifyUnassignedEvents);
    setTemplates((current) => current ?? { ...config.templates });
  }, [config]);

  const refreshDevices = useCallback(async () => {
    const result = (await listDevices({})) as DevicesResult;
    setDevices(result.devices ?? []);
  }, [listDevices]);

  const readExistingSubscription = useCallback(async () => {
    if (!swSupported) return;
    const registration = await navigator.serviceWorker.getRegistration(pluginUiBase());
    const subscription = await registration?.pushManager.getSubscription();
    setCurrentEndpoint(subscription?.endpoint ?? null);
  }, [swSupported]);

  useEffect(() => {
    void refreshDevices().catch((cause: unknown) => setError(String(cause)));
    void readExistingSubscription();
  }, [readExistingSubscription, refreshDevices]);

  /**
   * Save the whole configuration object.
   *
   * The host replaces `configJson` wholesale, so both sections send every key —
   * otherwise saving notification text would clear the trigger defaults.
   */
  const saveConfig = useCallback(async () => {
    const pluginId = pluginRecordId();
    const companyId = props.context.companyId;
    if (!pluginId || !companyId || defaultTriggers === null || notifyUnassigned === null) {
      setConfigError("Could not determine the plugin or the active company.");
      return;
    }

    const prunedTemplates: Record<string, NotificationTemplate> = {};
    for (const [eventType, template] of Object.entries(templates ?? {})) {
      const title = template.title?.trim();
      const body = template.body?.trim();
      if (title || body) prunedTemplates[eventType] = { ...(title ? { title } : {}), ...(body ? { body } : {}) };
    }

    setSaving(true);
    setConfigError(null);
    setConfigNotice(null);
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyId,
          configJson: {
            defaultTriggers,
            notifyUnassignedEvents: notifyUnassigned,
            templates: prunedTemplates,
          },
        }),
      });
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error(
            "Only an instance admin can change these settings. Individual devices keep their own switches below.",
          );
        }
        const detail = await response.text().catch(() => "");
        throw new Error(`Save failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
      }
      setConfigNotice("Saved");
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [
    defaultTriggers,
    notifyUnassigned,
    props.context.companyId,
    templates,
  ]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!config) throw new Error("Plugin configuration is still loading.");
      if (!secureContext) throw new Error("Web Push needs an HTTPS origin (localhost is allowed).");
      if (!swSupported || !pushSupported) {
        throw new Error("This browser does not support service workers or the Push API.");
      }

      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        throw new Error(
          result === "denied"
            ? "Notifications are blocked for this site. Re-allow them in the browser's site settings, then try again."
            : "Notification permission was not granted.",
        );
      }

      const base = pluginUiBase();
      await pruneStaleRegistrations(base);
      const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
      await waitForActiveWorker(registration);

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
        }));

      const eventTypes = config.eventTypes
        .filter((option) => option.defaultEnabled)
        .map((option) => option.type);

      const registered = (await registerSubscription({
        subscription: subscription.toJSON(),
        eventTypes,
        label: deviceLabel(),
        userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
        origin: window.location.origin,
      })) as DevicesResult;

      setDevices(registered.devices ?? []);
      setCurrentEndpoint(subscription.endpoint);
      setNotice("This browser is registered. Send a test notification to confirm delivery.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [config, pushSupported, registerSubscription, secureContext, swSupported]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const base = pluginUiBase();
      const registration = await navigator.serviceWorker.getRegistration(base);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await removeDevice({ endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setCurrentEndpoint(null);
      await refreshDevices();
      setNotice("This browser will no longer receive notifications.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [refreshDevices, removeDevice]);

  const runTest = useCallback(
    async (endpoint?: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = (await sendTest(endpoint ? { endpoint } : {})) as TestResult;
        setDevices(result.devices ?? []);
        const failed = (result.results ?? []).filter((entry) => !entry.ok);
        if (failed.length === 0) {
          setNotice(
            "Test push accepted by the push service. If nothing appeared, check the OS notification settings for this browser.",
          );
        } else {
          setError(
            failed
              .map(
                (entry) =>
                  `${endpointTail(entry.endpoint)} → ${entry.statusCode ?? "error"}: ${entry.error ?? "unknown"}`,
              )
              .join("\n"),
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [sendTest],
  );

  const toggleEventType = useCallback(
    async (device: Device, eventType: string) => {
      setBusy(true);
      setError(null);
      try {
        const next = device.eventTypes.includes(eventType)
          ? device.eventTypes.filter((entry) => entry !== eventType)
          : [...device.eventTypes, eventType];
        const result = (await updateSubscription({
          endpoint: device.endpoint,
          eventTypes: next,
        })) as DevicesResult;
        setDevices(result.devices ?? []);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [updateSubscription],
  );

  const remove = useCallback(
    async (endpoint: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = (await removeDevice({ endpoint })) as DevicesResult;
        setDevices(result.devices ?? []);
        if (endpoint === currentEndpoint) setCurrentEndpoint(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [currentEndpoint, removeDevice],
  );

  const thisBrowserRegistered = devices.some((device) => device.endpoint === currentEndpoint);
  const organizationName = config?.organizationName || "Your organization";
  const eventTypes = config?.eventTypes ?? [];

  const toggleDefaultTrigger = (eventType: string) => {
    setDefaultTriggers((current) => {
      const list = current ?? [];
      return list.includes(eventType)
        ? list.filter((entry) => entry !== eventType)
        : [...list, eventType];
    });
  };

  /**
   * What one trigger will actually send, with sample values in its objects.
   *
   * Mirrors `buildNotification` exactly, including the one asymmetry: an empty
   * field keeps the built-in wording (which the organization name prefixes),
   * while a field with text is sent verbatim. Otherwise the preview would
   * promise a prefix that a custom message never gets.
   */
  const preview = useMemo(() => {
    return (eventType: string) => {
      const defaults = previewDefaults(eventType as NotifiableEventType, { agentName: SAMPLE_AGENT_NAME });
      const vars = sampleTemplateVars(eventType as NotifiableEventType, organizationName);
      const template = templates?.[eventType];
      const customTitle = template?.title?.trim();
      const customBody = template?.body?.trim();
      return {
        title: customTitle
          ? renderTemplate(customTitle, vars)
          : `${organizationName} · ${defaults.title}`,
        body: customBody ? renderTemplate(customBody, vars) : defaults.body,
        customised: Boolean(customTitle || customBody),
      };
    };
  }, [organizationName, templates]);

  const setTemplateField = (eventType: string, field: "title" | "body", value: string) => {
    setTemplates((current) => ({
      ...(current ?? {}),
      [eventType]: { ...(current?.[eventType] ?? {}), [field]: value },
    }));
  };

  /** Drop a trigger's custom wording, which puts its built-in text back. */
  const clearTemplate = (eventType: string) => {
    setTemplates((current) => {
      const next = { ...(current ?? {}) };
      delete next[eventType];
      return next;
    });
  };

  return (
    <div className="pcp-page">
      <div className="pcp-header">
        <BellIcon />
        <h1>Notifications</h1>
      </div>

      {notice ? <p className="pcp-hint">{notice}</p> : null}
      {error ? <div className="pcp-error">{error}</div> : null}

      <Section label="This browser">
        <p className="pcp-hint">
          A registered browser is stored against your account, not against one organization, so it keeps
          receiving notifications from every organization you belong to.
          {secureContext ? "" : " This origin is not a secure context, so push is unavailable here."}
          {typeof Notification === "undefined" ? "" : ` Permission: ${permission}.`}
        </p>
        <div className="pcp-actions">
          <button
            type="button"
            className="pcp-btn"
            onClick={enable}
            disabled={busy || !config}
            data-testid="enable-notifications"
          >
            {thisBrowserRegistered ? "Re-register this browser" : "Enable notifications"}
          </button>
          <button
            type="button"
            className="pcp-btn pcp-btn-outline"
            onClick={() => void runTest()}
            disabled={busy || devices.length === 0}
          >
            Send test notification
          </button>
          {currentEndpoint ? (
            <button
              type="button"
              className="pcp-btn pcp-btn-destructive"
              onClick={disable}
              disabled={busy}
            >
              Turn off for this browser
            </button>
          ) : null}
        </div>
        {config ? (
          <p className="pcp-hint">
            At most {config.throttle.max} notifications per device every {config.throttle.windowMinutes} minutes;
            anything beyond that is recorded as throttled.
          </p>
        ) : null}
      </Section>

      <Section label={`Registered devices (${devices.length})`}>
        <p className="pcp-hint">One entry per browser profile that enabled notifications.</p>
        {devices.length === 0 ? <p className="pcp-hint">No device is registered for your account yet.</p> : null}
        {devices.map((device) => (
          <div
            key={device.endpoint}
            className="pcp-card"
            data-testid="device-row"
            data-device-current={device.endpoint === currentEndpoint ? "true" : "false"}
          >
            <div className="pcp-toggle-row">
              <span className="pcp-field-label" style={{ margin: 0 }}>
                {device.endpoint === currentEndpoint ? "This browser" : "Another device"}
              </span>
              <span className="pcp-mono">{endpointTail(device.endpoint)}</span>
            </div>
            <p className="pcp-hint">
              {device.deliveries[0]
                ? `Last: ${device.deliveries[0].status} · ${device.deliveries[0].eventType}`
                : "No deliveries yet"}
            </p>

            <div className="pcp-group">
              {eventTypes.map((option) => (
                <ToggleField
                  key={option.type}
                  label={option.label}
                  checked={device.eventTypes.includes(option.type)}
                  disabled={busy}
                  onChange={() => void toggleEventType(device, option.type)}
                  testId={`device-trigger-${option.type}`}
                />
              ))}
            </div>

            <div className="pcp-actions">
              <button
                type="button"
                className="pcp-btn pcp-btn-outline"
                onClick={() => void runTest(device.endpoint)}
                disabled={busy}
              >
                Test this device
              </button>
              <button
                type="button"
                className="pcp-btn pcp-btn-destructive"
                onClick={() => void remove(device.endpoint)}
                disabled={busy}
              >
                Remove
              </button>
            </div>

            {device.deliveries.length > 0 ? (
              <ul className="pcp-list">
                {device.deliveries.map((delivery, index) => (
                  <li key={`${delivery.createdAt}-${index}`} className="pcp-mono">
                    {delivery.status} · {delivery.eventType}
                    {delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ""}
                    {delivery.error ? ` · ${delivery.error.slice(0, 120)}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </Section>

      <Section label="Notification content" testId="notification-content">
        <p className="pcp-hint">
          Each trigger below shows what it will send. Open one to write your own wording: the text is
          composed from words and objects, and an object is inserted from a list — never typed — so a
          notification cannot arrive with a misspelled object in it. An empty field keeps the built-in
          wording.
        </p>

        {eventTypes.map((option) => {
          const defaults = previewDefaults(option.type as NotifiableEventType, { agentName: SAMPLE_AGENT_NAME });
          const shown = preview(option.type);
          const template = templates?.[option.type];
          const open = openTrigger === option.type;
          const suspicious = [template?.title, template?.body].some(
            (text) => text !== undefined && hasUnknownPlaceholder(text),
          );

          return (
            <div key={option.type} className="pcp-trigger" data-testid={`trigger-${option.type}`}>
              {/*
                The row is the control: the trigger's name, what it sends, and whether
                it has been customised. Everything else waits behind it, so the section
                can be read in one screen instead of scrolled through.
              */}
              <button
                type="button"
                className="pcp-trigger-row"
                aria-expanded={open}
                aria-controls={`trigger-body-${option.type}`}
                onClick={() => setOpenTrigger(open ? null : option.type)}
                data-testid={`open-${option.type}`}
              >
                <span className="pcp-trigger-labels">
                  <span className="pcp-trigger-name">{option.label}</span>
                  <span className="pcp-trigger-summary" data-testid={`summary-${option.type}`}>
                    {shown.body ? `${shown.title} — ${shown.body}` : shown.title}
                  </span>
                </span>
                {shown.customised ? <span className="pcp-badge">Customised</span> : null}
                <svg
                  className="pcp-chevron"
                  data-open={open ? "true" : "false"}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {open ? (
                <div className="pcp-trigger-body" id={`trigger-body-${option.type}`}>
                  {/*
                    Not the `Field` wrapper used for the trigger switches: that one is
                    a <label>, and a label forwards a click anywhere inside it to its
                    first labelable descendant — which here is the insert button.
                  */}
                  <EditorField label="Title">
                    <TemplateEditor
                      value={template?.title ?? ""}
                      objects={templateObjectsFor(option.type as NotifiableEventType)}
                      builtIn={defaults.title}
                      onChange={(next) => setTemplateField(option.type, "title", next)}
                      testId={`template-title-${option.type}`}
                      ariaLabel={`${option.label} notification title`}
                    />
                  </EditorField>

                  <EditorField label="Body">
                    <TemplateEditor
                      value={template?.body ?? ""}
                      objects={templateObjectsFor(option.type as NotifiableEventType)}
                      builtIn={defaults.body}
                      onChange={(next) => setTemplateField(option.type, "body", next)}
                      testId={`template-body-${option.type}`}
                      ariaLabel={`${option.label} notification body`}
                    />
                  </EditorField>

                  <div>
                    <span className="pcp-field-label">What gets sent</span>
                    <div className="pcp-notification" data-testid={`preview-${option.type}`}>
                      <div className="pcp-notification-head">
                        <span className="pcp-notification-icon">
                          <BellIcon />
                        </span>
                        <span className="pcp-notification-app">Paperclip</span>
                        <span className="pcp-notification-time">now</span>
                      </div>
                      <div className="pcp-notification-title" data-testid={`preview-title-${option.type}`}>
                        {shown.title}
                      </div>
                      <div className="pcp-notification-body" data-testid={`preview-body-${option.type}`}>
                        {shown.body}
                      </div>
                    </div>
                  </div>

                  {suspicious ? (
                    <p className="pcp-hint">
                      A {"{{name}}"} that is not in the insert list is not an object, so it arrives as
                      written. Remove it, or insert the real object.
                    </p>
                  ) : null}

                  {shown.customised ? (
                    <div className="pcp-actions">
                      <button
                        type="button"
                        className="pcp-btn pcp-btn-outline"
                        onClick={() => clearTemplate(option.type)}
                        disabled={saving}
                        data-testid={`reset-${option.type}`}
                      >
                        Put the built-in wording back
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="pcp-actions">
          <button
            type="button"
            className="pcp-btn"
            onClick={() => void saveConfig()}
            disabled={saving || defaultTriggers === null}
            data-testid="save-notification-content"
          >
            {saving ? "Saving…" : "Save notification content"}
          </button>
          <span className="pcp-hint">Saving requires an instance admin.</span>
          {configNotice ? (
            <span className="pcp-hint" data-testid="config-notice">
              {configNotice}
            </span>
          ) : null}
        </div>
        {configError ? (
          <div className="pcp-error" data-testid="config-error">
            {configError}
          </div>
        ) : null}
      </Section>

      <Section label="Organization defaults" testId="org-defaults">
        <p className="pcp-hint">
          The triggers a browser starts with when someone clicks Enable notifications. Each device can still
          change its own set afterwards.
        </p>

        <div className="pcp-group">
          {eventTypes.map((option) => (
            <ToggleField
              key={option.type}
              label={option.label}
              checked={(defaultTriggers ?? []).includes(option.type)}
              disabled={saving || defaultTriggers === null}
              onChange={() => toggleDefaultTrigger(option.type)}
              testId={`default-trigger-${option.type}`}
            />
          ))}
        </div>

        <ToggleField
          label="Also notify about events that name nobody responsible"
          hint="When off, only events that name a responsible user notify anyone."
          checked={notifyUnassigned ?? true}
          disabled={saving || notifyUnassigned === null}
          onChange={setNotifyUnassigned}
          testId="notify-unassigned"
        />

        <div className="pcp-actions">
          <button
            type="button"
            className="pcp-btn"
            onClick={() => void saveConfig()}
            disabled={saving || defaultTriggers === null || notifyUnassigned === null}
            data-testid="save-org-defaults"
          >
            {saving ? "Saving…" : "Save organization defaults"}
          </button>
          {configNotice ? (
            <span className="pcp-hint" data-testid="config-notice">
              {configNotice}
            </span>
          ) : null}
        </div>
        {configError ? (
          <div className="pcp-error" data-testid="config-error">
            {configError}
          </div>
        ) : null}
      </Section>

      <p className="pcp-note">
        Notifications arrive through the browser's push service, so they reach you with the app closed. iOS
        Safari only delivers Web Push to a site added to the Home Screen. The toolbar's fullscreen button gives
        an immersive window in browsers that cannot install the app — for example a private, tailnet-only origin.
      </p>
    </div>
  );
}

/**
 * Remove service workers left behind by an earlier install of this plugin.
 *
 * A plugin is served under `/_plugins/<record id>/ui/`, and reinstalling one mints
 * a new record id — so a browser accumulates registrations for ids that no longer
 * exist. That is not only clutter: Chrome keeps one push subscription per origin,
 * attached to the registration that created it, so the orphaned worker keeps
 * receiving every push while the current one sees nothing. The notification still
 * appears (the old worker shows it), but anything the current build does with the
 * push — a deep link that changed, an updated payload field — silently does not
 * apply.
 *
 * Called before registering, so the subscription this page is about to create
 * belongs to the worker that is actually current. Only the plugin's own scoped
 * registrations are touched, never the app's root-scoped `/sw.js`.
 */
async function pruneStaleRegistrations(currentBase: string): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    if (!registration.scope.includes("/_plugins/")) continue;
    if (registration.scope.startsWith(currentBase)) continue;
    try {
      // Drop the subscription first: it is the origin's only one, and it has to
      // be released for the new registration to be given its own.
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
      await registration.unregister();
    } catch {
      // A registration that refuses to go is not a reason to fail the click.
    }
  }
}

/**
 * Wait until *this* registration has an active worker.
 *
 * `navigator.serviceWorker.ready` is the wrong tool here: it resolves as soon as
 * any worker controls the page, and the host app's own root-scoped `/sw.js`
 * already does. Calling `pushManager.subscribe()` at that point throws
 * "Subscription failed - no active Service Worker" on a first-ever visit, when
 * our freshly registered worker is still installing. On a browser that has
 * visited before the worker is already active, which is exactly why the bug only
 * shows up for new users.
 */
async function waitForActiveWorker(registration: ServiceWorkerRegistration): Promise<void> {
  const active = async () =>
    (await navigator.serviceWorker.getRegistration(registration.scope))?.active;
  if (registration.active) return;

  const worker = registration.installing ?? registration.waiting;
  if (worker && worker.state !== "activated") {
    await new Promise<void>((resolve) => {
      const onStateChange = () => {
        if (worker.state === "activated") {
          worker.removeEventListener("statechange", onStateChange);
          resolve();
        }
      };
      worker.addEventListener("statechange", onStateChange);
      // A worker that is already activated between the check above and the
      // listener attach would otherwise hang this promise forever.
      onStateChange();
    });
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await active()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("The plugin's service worker did not activate in time. Reload the page and try again.");
}
