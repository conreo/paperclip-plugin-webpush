import { useCallback, useEffect, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

type EventTypeOption = { type: string; label: string; defaultEnabled: boolean };
type ClientConfig = {
  vapidPublicKey: string;
  eventTypes: EventTypeOption[];
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
  const active = async () => (await navigator.serviceWorker.getRegistration(registration.scope))?.active;
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

const sectionStyle: React.CSSProperties = { display: "grid", gap: "0.5rem" };
const mutedStyle: React.CSSProperties = { opacity: 0.7, fontSize: "0.8rem" };
const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  flexWrap: "wrap",
};

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

  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const swSupported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const pushSupported = typeof window !== "undefined" && "PushManager" in window;

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
      setNotice("This browser is now registered. Send a test notification to confirm delivery.");
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

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "48rem" }}>
      <header style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Notifications on this browser</h2>
        <div style={mutedStyle}>
          {secureContext ? "HTTPS origin" : "insecure origin"} · permission: {permission} ·{" "}
          {pushSupported && swSupported ? "Push API available" : "Push API unavailable"}
        </div>
      </header>

      {notice ? <div style={{ fontSize: "0.85rem" }}>{notice}</div> : null}
      {error ? (
        <div style={{ fontSize: "0.85rem", color: "crimson", whiteSpace: "pre-wrap" }}>{error}</div>
      ) : null}

      <section style={sectionStyle}>
        <div style={rowStyle}>
          <button type="button" onClick={enable} disabled={busy || !config}>
            {thisBrowserRegistered ? "Re-register this browser" : "Enable notifications"}
          </button>
          <button type="button" onClick={() => void runTest()} disabled={busy || devices.length === 0}>
            Send test notification
          </button>
          {currentEndpoint ? (
            <button type="button" onClick={disable} disabled={busy}>
              Turn off for this browser
            </button>
          ) : null}
          <button type="button" onClick={() => void refreshDevices()} disabled={busy}>
            Refresh
          </button>
        </div>
        {config ? (
          <div style={mutedStyle}>
            At most {config.throttle.max} notifications per device every {config.throttle.windowMinutes}{" "}
            minutes; extras are recorded as throttled.
          </div>
        ) : null}
      </section>

      <section style={sectionStyle}>
        <strong style={{ fontSize: "0.9rem" }}>Registered devices ({devices.length})</strong>
        {devices.length === 0 ? (
          <div style={mutedStyle}>
            No device is registered for your account yet. Devices are per person, not per
            company: once registered, this browser receives alerts for anything you are
            responsible for, in every company.
          </div>
        ) : null}

        {devices.map((device) => (
          <div
            key={device.endpoint}
            data-testid="device-row"
            data-device-current={device.endpoint === currentEndpoint ? "true" : "false"}
            style={{
              border: "1px solid currentColor",
              borderRadius: "0.5rem",
              padding: "0.75rem",
              display: "grid",
              gap: "0.5rem",
            }}
          >
            <div style={rowStyle}>
              <strong style={{ fontSize: "0.85rem" }}>
                {device.endpoint === currentEndpoint ? "This browser" : "Another device"}
              </strong>
              <code style={{ fontSize: "0.72rem", opacity: 0.7 }}>{endpointTail(device.endpoint)}</code>
              <span style={{ ...mutedStyle, marginLeft: "auto" }}>
                {device.deliveries[0]
                  ? `last: ${device.deliveries[0].status} ${device.deliveries[0].eventType}`
                  : "no deliveries yet"}
              </span>
            </div>

            <div style={{ display: "grid", gap: "0.25rem" }}>
              {(config?.eventTypes ?? []).map((option) => {
                const checked = device.eventTypes.includes(option.type);
                return (
                  <label key={option.type} style={{ fontSize: "0.8rem", display: "flex", gap: "0.4rem" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => void toggleEventType(device, option.type)}
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>

            <div style={rowStyle}>
              <button type="button" onClick={() => void runTest(device.endpoint)} disabled={busy}>
                Test this device
              </button>
              <button type="button" onClick={() => void remove(device.endpoint)} disabled={busy}>
                Remove
              </button>
            </div>

            {device.deliveries.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.72rem", opacity: 0.75 }}>
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
      </section>

      <section style={{ ...sectionStyle, ...mutedStyle }}>
        <div>
          Notifications are delivered by the browser's own push service, so they arrive even when the
          Paperclip tab is closed. iOS Safari only supports Web Push for sites added to the Home
          Screen.
        </div>
      </section>
    </div>
  );
}
