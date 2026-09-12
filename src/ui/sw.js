/**
 * Web Push service worker for the Paperclip Web Push plugin.
 *
 * Served as a static file from the plugin's UI directory, which the host exposes
 * at `/_plugins/<pluginId>/ui/sw.js`. Two consequences of that path matter:
 *
 *  - The registration's scope is limited to `/_plugins/<pluginId>/ui/` (the host
 *    sets no `Service-Worker-Allowed` header). That is fine: Web Push only needs
 *    a `push` listener and `notificationclick`, and `clients.openWindow()` is
 *    not scope-restricted. This worker deliberately does NOT intercept `fetch`,
 *    so it can never interfere with the app's own root-scoped `/sw.js`.
 *  - It coexists with that root worker rather than replacing it.
 */

const SW_BUILD_ID = "0.2.0";

self.addEventListener("install", () => {
  // No precaching to do: this worker is a push receiver, not an offline cache.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * The most recent push this worker showed.
 *
 * "Did the message I composed actually arrive, and what did it say?" is the one
 * question a push channel otherwise cannot answer from the app: the notification
 * lives in the OS, and `getNotifications()` is unreliable in a headless browser.
 *
 * Stored in the Cache API rather than in a variable, because the browser stops an
 * idle service worker after a few tens of seconds — an in-memory record is gone
 * exactly when someone comes looking for it. This cache is the worker's own, and
 * the worker registers no `fetch` listener, so it cannot serve anything to the app.
 */
const LAST_PUSH_CACHE = "webpush-last-push";
const LAST_PUSH_KEY = "/last-push";

async function rememberPush(payload) {
  try {
    const cache = await caches.open(LAST_PUSH_CACHE);
    await cache.put(LAST_PUSH_KEY, new Response(JSON.stringify(payload)));
  } catch {
    // Best effort: not being able to record a diagnostic must never stop a
    // notification from being shown.
  }
}

async function readLastPush() {
  try {
    const cache = await caches.open(LAST_PUSH_CACHE);
    const response = await cache.match(LAST_PUSH_KEY);
    return response ? await response.json() : null;
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = { title: "Paperclip", body: event.data ? event.data.text() : "" };
      }

      const title = payload.title || "Paperclip";
      const body = payload.body || "";
      await rememberPush({ title, body, url: payload.url || "/", tag: payload.tag || null, at: Date.now() });

      await self.registration.showNotification(title, {
        body,
        tag: payload.tag || payload.eventId || undefined,
        data: { url: payload.url || "/" },
        icon: payload.icon || "/android-chrome-192x192.png",
        badge: payload.badge || "/favicon-32x32.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  const origin = self.location.origin;

  // focus() and openWindow() both need user activation, which a real tap grants.
  // They can still refuse (a window that cannot be raised, an embedded context),
  // and a refusal must not end the handler: fall through, so a click always lands.
  const focusQuietly = async (client) => {
    try {
      await client.focus();
      return true;
    } catch {
      return false;
    }
  };

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const targetPath = new URL(target, origin).pathname;

      // Already showing the destination: raise it rather than opening a duplicate.
      const sameTarget = clientList.find((client) => {
        try {
          return new URL(client.url).pathname === targetPath;
        } catch {
          return false;
        }
      });
      if (sameTarget && (await focusQuietly(sameTarget))) return;

      // Reach the destination by opening it.
      //
      // This worker is registered under `/_plugins/<id>/ui/`, so it controls no
      // app window — the app's own root-scoped `/sw.js` does. `WindowClient.
      // navigate()` therefore rejects with "this service worker is not the
      // client's active service worker", and focusing a window without navigating
      // would raise the app at whatever page it was already on. Opening the URL is
      // the only route that actually arrives at the deep link.
      try {
        await self.clients.openWindow(target);
        return;
      } catch {
        // No activation, or the browser refused to open a window.
      }

      // Last resort: raise the app, so the tap still has a visible effect.
      for (const client of clientList) {
        if (!client.url.startsWith(origin)) continue;
        if (await focusQuietly(client)) return;
      }
    })(),
  );
});

// Lets the settings page ask "is the worker I registered actually ours, and
// which build is it?" without guessing from a registration object alone, and ask
// what the last push said. Both answers come back on a port the caller supplies.
self.addEventListener("message", (event) => {
  const port = event.ports && event.ports[0];
  if (!port) return;

  if (event.data && event.data.type === "last-push") {
    // Reading is asynchronous, and the message event stays alive until the port
    // has been answered.
    event.waitUntil(
      readLastPush().then((payload) => port.postMessage({ type: "last-push", payload })),
    );
    return;
  }

  port.postMessage({ type: "pong", buildId: SW_BUILD_ID, scope: self.registration.scope });
});
