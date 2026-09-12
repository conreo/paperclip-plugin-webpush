import { useCallback, useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  SAMPLE_AGENT_NAME,
  previewDefaults,
  renderTemplate,
  sampleTemplateVars,
  type NotifiableEventType,
} from "../notifications.js";

type EventTypeOption = { type: string; label: string; defaultEnabled: boolean };
type NotificationTemplate = { title?: string; body?: string };
type ClientConfig = {
  vapidPublicKey: string;
  eventTypes: EventTypeOption[];
  notifyUnassignedEvents: boolean;
  organizationName: string | null;
  includeOrganizationLabel: boolean;
  includeAgentName: boolean;
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
 * Styling mirrors the host's settings layout using its own CSS variables: the
 * plugin UI may not import host components, and Tailwind only generates the
 * classes the host's own sources use.
 */
const pageStyle = { display: "grid", gap: "2rem", maxWidth: "52rem" } as const;
const sectionStyle = { display: "grid", gap: "0.75rem" } as const;
const sectionHeader = { display: "grid", gap: "0.375rem" } as const;
const headingStyle = { fontSize: "1.125rem", fontWeight: 600, margin: 0 } as const;
const sectionTitle = { fontSize: "0.875rem", fontWeight: 600, margin: 0 } as const;
const sectionDescription = {
  fontSize: "0.875rem",
  color: "var(--muted-foreground)",
  margin: 0,
  maxWidth: "42rem",
} as const;
const rowStyle = {
  display: "flex",
  gap: "1rem",
  alignItems: "flex-start",
  justifyContent: "space-between",
} as const;
const fieldLabel = { fontSize: "0.875rem", fontWeight: 600, margin: 0 } as const;
const fieldHint = {
  fontSize: "0.8125rem",
  color: "var(--muted-foreground)",
  margin: 0,
  maxWidth: "42rem",
} as const;
const inputStyle = {
  width: "100%",
  padding: "0.375rem 0.5rem",
  fontSize: "0.875rem",
  fontFamily: "inherit",
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--input)",
  borderRadius: "var(--radius-md)",
} as const;
const primaryButtonStyle = {
  padding: "0.4rem 0.75rem",
  fontSize: "0.875rem",
  fontWeight: 500,
  color: "var(--primary-foreground)",
  background: "var(--primary)",
  border: "1px solid transparent",
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
} as const;
const secondaryButtonStyle = {
  ...primaryButtonStyle,
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--border)",
} as const;
const checkboxStyle = {
  accentColor: "var(--primary)",
  width: "1rem",
  height: "1rem",
  marginTop: "0.125rem",
  flexShrink: 0,
} as const;
const cardStyle = {
  display: "grid",
  gap: "0.5rem",
  padding: "0.75rem",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  background: "var(--card)",
} as const;
const subHeadingStyle = {
  fontSize: "0.75rem",
  fontWeight: 500,
  letterSpacing: "0.05em",
  textTransform: "uppercase" as const,
  color: "var(--muted-foreground)",
  margin: 0,
} as const;
const noticeStyle = { fontSize: "0.8125rem" } as const;
const errorStyle = {
  fontSize: "0.8125rem",
  color: "var(--destructive)",
  whiteSpace: "pre-wrap" as const,
} as const;
const buttonRowStyle = { display: "flex", flexWrap: "wrap" as const, gap: "0.5rem" } as const;

function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section style={sectionStyle} data-testid={testId}>
      <div style={sectionHeader}>
        <h2 style={sectionTitle}>{title}</h2>
        {description ? <p style={sectionDescription}>{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** The host's General page uses a switch, not a checkbox; this mirrors it. */
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
      style={{
        position: "relative",
        flexShrink: 0,
        width: "2.25rem",
        height: "1.25rem",
        padding: 0,
        borderRadius: "999px",
        border: "1px solid var(--border)",
        background: checked ? "var(--primary)" : "var(--input)",
        cursor: disabled ? "default" : "pointer",
        transition: "background 140ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "50%",
          left: checked ? "calc(100% - 1.0625rem)" : "0.125rem",
          transform: "translateY(-50%)",
          width: "0.9375rem",
          height: "0.9375rem",
          borderRadius: "999px",
          background: "var(--background)",
          boxShadow: "0 1px 2px rgb(0 0 0 / 0.25)",
          transition: "left 140ms ease",
        }}
      />
    </button>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
  testId,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <label style={{ ...rowStyle, cursor: disabled ? "default" : "pointer" }}>
      <span style={{ display: "grid", gap: "0.25rem" }}>
        <span style={fieldLabel}>{title}</span>
        <span style={fieldHint}>{description}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={title} testId={testId} />
    </label>
  );
}

export function SettingsPage(props: PluginSettingsPageProps) {
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
  const [organizationLabel, setOrganizationLabel] = useState<string | null>(null);
  const [includeOrganizationLabel, setIncludeOrganizationLabel] = useState<boolean | null>(null);
  const [includeAgentName, setIncludeAgentName] = useState<boolean | null>(null);
  const [templates, setTemplates] = useState<Record<string, NotificationTemplate> | null>(null);
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
    setOrganizationLabel((current) => current ?? config.organizationName ?? "");
    setIncludeOrganizationLabel((current) => current ?? config.includeOrganizationLabel);
    setIncludeAgentName((current) => current ?? config.includeAgentName);
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
            ...(organizationLabel?.trim() ? { organizationLabel: organizationLabel.trim() } : {}),
            includeOrganizationLabel: includeOrganizationLabel ?? true,
            includeAgentName: includeAgentName ?? true,
            templates: prunedTemplates,
          },
        }),
      });
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error(
            "Only an instance admin can change these settings. Individual devices keep their own checkboxes below.",
          );
        }
        const detail = await response.text().catch(() => "");
        throw new Error(`Save failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
      }
      setConfigNotice("Saved.");
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [
    defaultTriggers,
    includeAgentName,
    includeOrganizationLabel,
    notifyUnassigned,
    organizationLabel,
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
  const effectiveLabel = organizationLabel?.trim() || config?.organizationName || "Your organization";
  const showLabel = includeOrganizationLabel ?? true;

  /** A faithful preview of one trigger, rendered with sample placeholder values. */
  const preview = useMemo(() => {
    return (eventType: string) => {
      // The preview shows what an agent-created event would produce, while the
      // field placeholders stay generic.
      const defaults = previewDefaults(eventType as NotifiableEventType, { agentName: SAMPLE_AGENT_NAME });
      const vars = sampleTemplateVars(eventType as NotifiableEventType, effectiveLabel);
      const template = templates?.[eventType];
      const title = template?.title?.trim() ? renderTemplate(template.title, vars) : defaults.title;
      const body = template?.body?.trim() ? renderTemplate(template.body, vars) : defaults.body;
      const placesOwnLabel = (template?.title ?? "").includes("{{org}}");
      return {
        title: showLabel && !placesOwnLabel ? `${effectiveLabel} · ${title}` : title,
        body,
      };
    };
  }, [effectiveLabel, showLabel, templates]);

  const setTemplateField = (eventType: string, field: "title" | "body", value: string) => {
    setTemplates((current) => ({
      ...(current ?? {}),
      [eventType]: { ...(current?.[eventType] ?? {}), [field]: value },
    }));
  };

  return (
    <div style={pageStyle}>
      <div style={{ display: "grid", gap: "0.375rem" }}>
        <h1 style={headingStyle}>Notifications</h1>
        <p style={sectionDescription}>
          Delivered by this browser's own push service, so they arrive with the Paperclip tab closed.
          {secureContext ? "" : " This origin is not a secure context, so push is unavailable here."}
          {typeof Notification === "undefined" ? "" : ` Permission: ${permission}.`}
        </p>
      </div>

      {notice ? <div style={noticeStyle}>{notice}</div> : null}
      {error ? <div style={errorStyle}>{error}</div> : null}

      <Section
        title="This browser"
        description="Registering a browser creates a push subscription and stores it against your account, not against one organization."
      >
        <div style={buttonRowStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={enable}
            disabled={busy || !config}
            data-testid="enable-notifications"
          >
            {thisBrowserRegistered ? "Re-register this browser" : "Enable notifications"}
          </button>
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={() => void runTest()}
            disabled={busy || devices.length === 0}
          >
            Send test notification
          </button>
          {currentEndpoint ? (
            <button type="button" style={secondaryButtonStyle} onClick={disable} disabled={busy}>
              Turn off for this browser
            </button>
          ) : null}
        </div>
        {config ? (
          <p style={fieldHint}>
            At most {config.throttle.max} notifications per device every {config.throttle.windowMinutes} minutes;
            anything beyond that is recorded as throttled.
          </p>
        ) : null}
      </Section>

      <Section
        title={`Registered devices (${devices.length})`}
        description="One entry per browser profile that enabled notifications."
      >
        {devices.length === 0 ? (
          <p style={fieldHint}>No device is registered for your account yet.</p>
        ) : null}
        {devices.map((device) => (
          <div
            key={device.endpoint}
            style={cardStyle}
            data-testid="device-row"
            data-device-current={device.endpoint === currentEndpoint ? "true" : "false"}
          >
            <div style={{ ...rowStyle, alignItems: "center" }}>
              <span style={fieldLabel}>
                {device.endpoint === currentEndpoint ? "This browser" : "Another device"}
              </span>
              <code style={{ fontSize: "0.72rem", color: "var(--muted-foreground)" }}>
                {endpointTail(device.endpoint)}
              </code>
              <span style={{ ...fieldHint, marginLeft: "auto" }}>
                {device.deliveries[0]
                  ? `last: ${device.deliveries[0].status} ${device.deliveries[0].eventType}`
                  : "no deliveries yet"}
              </span>
            </div>

            <div style={{ display: "grid", gap: "0.25rem" }}>
              {(config?.eventTypes ?? []).map((option) => {
                const checked = device.eventTypes.includes(option.type);
                return (
                  <label key={option.type} style={{ ...rowStyle, alignItems: "center", cursor: "pointer" }}>
                    <span style={{ fontSize: "0.8125rem" }}>{option.label}</span>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => void toggleEventType(device, option.type)}
                      style={checkboxStyle}
                      aria-label={option.label}
                    />
                  </label>
                );
              })}
            </div>

            <div style={buttonRowStyle}>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => void runTest(device.endpoint)}
                disabled={busy}
              >
                Test this device
              </button>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => void remove(device.endpoint)}
                disabled={busy}
              >
                Remove
              </button>
            </div>

            {device.deliveries.length > 0 ? (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.1rem",
                  fontSize: "0.72rem",
                  color: "var(--muted-foreground)",
                }}
              >
                {device.deliveries.map((delivery, index) => (
                  <li key={`${delivery.createdAt}-${index}`}>
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

      <Section
        title="Notification content"
        description="Leave a field empty to keep the wording shown in it. Placeholders work in any field: {{org}} {{agent}} {{identifier}} {{title}} {{type}} {{scope}} {{run}} — a placeholder this notification has no value for renders as nothing."
        testId="notification-content"
      >
        <ToggleRow
          title="Show the organization name"
          description="Puts the organization's name in front of notification titles, so you can tell which organization a notification came from."
          checked={showLabel}
          disabled={saving}
          onChange={setIncludeOrganizationLabel}
          testId="include-org-label"
        />

        {showLabel ? (
          // Its own row rather than a footnote to the switch: this is an override,
          // and the name it overrides is already known.
          <div style={{ ...rowStyle, alignItems: "center" }}>
            <span style={{ display: "grid", gap: "0.25rem" }}>
              <span style={fieldLabel}>Name to show</span>
              <span style={fieldHint}>
                Leave empty to use the organization's own name
                {config?.organizationName ? ` (${config.organizationName})` : ""}.
              </span>
            </span>
            <input
              type="text"
              value={organizationLabel ?? ""}
              placeholder={config?.organizationName ?? "Your organization"}
              onChange={(event) => setOrganizationLabel(event.target.value)}
              style={{ ...inputStyle, maxWidth: "18rem" }}
              aria-label="Name to show instead of the organization name"
              data-testid="org-label"
            />
          </div>
        ) : null}

        <ToggleRow
          title="Include the agent's name"
          description="Names the agent in notifications that are about one, such as a failed run or an approval an agent requested."
          checked={includeAgentName ?? true}
          disabled={saving}
          onChange={setIncludeAgentName}
          testId="include-agent-name"
        />

        <p style={subHeadingStyle}>Per notification</p>

        {(config?.eventTypes ?? []).map((option) => {
          const defaults = previewDefaults(option.type as NotifiableEventType);
          const shown = preview(option.type);
          const customised = Boolean(
            templates?.[option.type]?.title?.trim() || templates?.[option.type]?.body?.trim(),
          );
          return (
            <div key={option.type} style={cardStyle}>
              <span style={fieldLabel}>{option.label}</span>
              <div style={{ display: "grid", gap: "0.375rem" }}>
                <input
                  type="text"
                  value={templates?.[option.type]?.title ?? ""}
                  placeholder={defaults.title}
                  onChange={(event) => setTemplateField(option.type, "title", event.target.value)}
                  style={inputStyle}
                  aria-label={`${option.label} notification title`}
                  data-testid={`template-title-${option.type}`}
                />
                <input
                  type="text"
                  value={templates?.[option.type]?.body ?? ""}
                  placeholder={defaults.body}
                  onChange={(event) => setTemplateField(option.type, "body", event.target.value)}
                  style={inputStyle}
                  aria-label={`${option.label} notification body`}
                  data-testid={`template-body-${option.type}`}
                />
              </div>
              {customised ? (
                <p style={fieldHint}>
                  As sent: <strong style={{ color: "var(--foreground)" }}>{shown.title}</strong> — {shown.body}
                </p>
              ) : null}
            </div>
          );
        })}

        <div style={buttonRowStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => void saveConfig()}
            disabled={saving || defaultTriggers === null}
            data-testid="save-notification-content"
          >
            {saving ? "Saving…" : "Save notification content"}
          </button>
        </div>
      </Section>

      <Section
        title="Organization defaults"
        description="The triggers a browser starts with when someone clicks Enable notifications. Each device can still change its own set afterwards."
        testId="org-defaults"
      >
        <div style={{ display: "grid", gap: "0.25rem" }}>
          {(config?.eventTypes ?? []).map((option) => {
            const checked = (defaultTriggers ?? []).includes(option.type);
            return (
              <label key={option.type} style={{ ...rowStyle, alignItems: "center", cursor: "pointer" }}>
                <span style={{ fontSize: "0.8125rem" }}>{option.label}</span>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={saving || defaultTriggers === null}
                  onChange={() =>
                    setDefaultTriggers((current) => {
                      const list = current ?? [];
                      return list.includes(option.type)
                        ? list.filter((entry) => entry !== option.type)
                        : [...list, option.type];
                    })
                  }
                  style={checkboxStyle}
                  aria-label={option.label}
                />
              </label>
            );
          })}
        </div>

        <ToggleRow
          title="Also notify about events that name nobody responsible"
          description="When off, only events that name a responsible user notify anyone."
          checked={notifyUnassigned ?? true}
          disabled={saving || notifyUnassigned === null}
          onChange={setNotifyUnassigned}
          testId="notify-unassigned"
        />

        <div style={buttonRowStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => void saveConfig()}
            disabled={saving || defaultTriggers === null || notifyUnassigned === null}
            data-testid="save-org-defaults"
          >
            {saving ? "Saving…" : "Save organization defaults"}
          </button>
        </div>
        <p style={fieldHint}>Saving any of these settings requires an instance admin.</p>
        {configNotice ? <div style={noticeStyle}>{configNotice}</div> : null}
        {configError ? <div style={errorStyle}>{configError}</div> : null}
      </Section>

      <p style={fieldHint}>
        Notifications arrive through the browser's push service, so they reach you with the app closed. iOS Safari
        only delivers Web Push to a site added to the Home Screen. The toolbar's fullscreen button gives an
        immersive window in browsers that cannot install the app — for example a private, tailnet-only origin.
      </p>
    </div>
  );
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
