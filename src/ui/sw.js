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

const SW_BUILD_ID = "0.1.0-spike1";

self.addEventListener("install", () => {
  // No precaching to do: this worker is a push receiver, not an offline cache.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

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
      await self.registration.showNotification(title, {
        body: payload.body || "",
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

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      for (const client of clientList) {
        if (new URL(client.url).pathname === new URL(target, self.location.origin).pathname) {
          await client.focus();
          return;
        }
      }

      const anyClient = clientList[0];
      if (anyClient && "navigate" in anyClient && anyClient.url.startsWith(self.location.origin)) {
        await anyClient.focus();
        await anyClient.navigate(target);
        return;
      }

      await self.clients.openWindow(target);
    })(),
  );
});

// Lets the settings page ask "is the worker I registered actually ours, and
// which build is it?" without guessing from a registration object alone.
self.addEventListener("message", (event) => {
  const port = event.ports && event.ports[0];
  if (!port) return;
  port.postMessage({ type: "pong", buildId: SW_BUILD_ID, scope: self.registration.scope });
});
