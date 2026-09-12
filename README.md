# Paperclip Web Push Notifications

Desktop and Android push notifications for Paperclip board events, delivered as a
standalone Paperclip plugin. No changes to Paperclip core, no fork, no image
rebuild.

A board operator opens **Settings → Plugins → Web Push Notifications**, clicks
**Enable notifications**, and from then on their browser receives real OS
notifications when an approval needs a decision, a task is handed to them, an
agent run fails, or a budget threshold trips — including while the Paperclip tab
is closed.

## Requirements

| Requirement | Why |
| --- | --- |
| An **HTTPS** origin (or `localhost`) | Service workers and the Push API only exist in a secure context. Serve the instance over your own TLS terminator, `tailscale serve`, or any real certificate — a plain `http://<lan-ip>:port` origin silently gets no service worker and no push. |
| Chrome, Edge, Firefox, or Android Chrome | Web Push is supported in every current desktop browser and on Android. |
| iOS: Safari 16.4+ **and** Add to Home Screen | iOS only delivers Web Push to a web app installed on the Home Screen, and only when the manifest asks for a standalone window (`display: standalone`). Paperclip's manifest deliberately ships `display: "browser"`, so **iOS is out of scope** for this plugin until that changes. Desktop and Android are unaffected. |

## How it works

```
board action ──▶ activity log ──▶ plugin event ──▶ plugin worker
                                                   │  targeting + throttle
                                                   ▼
                              VAPID-signed, aes128gcm-encrypted push
                                                   │
                                                   ▼
                             browser push service ──▶ service worker ──▶ OS notification
```

Three pieces:

1. **Worker** (`src/worker.ts`, forked Node process) subscribes to the notifiable
   event types, decides who should hear about each event, and sends the push.
2. **Settings page** (`src/ui/SettingsPage.tsx`) runs same-origin inside the board,
   asks for notification permission on an explicit click, registers the service
   worker, creates the `PushSubscription`, and manages devices and event toggles.
3. **Service worker** (`src/ui/sw.js`) is served as a static file from the
   plugin's UI directory and handles `push` and `notificationclick`.

The service worker is registered at `/_plugins/<pluginId>/ui/sw.js`, with its
scope limited to that directory. It **coexists** with the app's own root-scoped
`/sw.js` rather than replacing it, and it deliberately registers no `fetch`
listener, so it can never interfere with the app's offline behaviour.

### Data

Subscriptions live in the plugin's own PostgreSQL namespace, never in core
tables:

- `push_subscription` — one row per browser profile, keyed by the push service
  endpoint (re-subscribing the same browser updates in place instead of stacking
  duplicates).
- `push_delivery` — one row per delivery attempt: the throttle ledger and the
  "why didn't I get that?" trail surfaced on the settings page.
- `vapid_keypair` — the instance's VAPID signing keypair, generated on first use.

## Behaviour

**Triggers** (each can be toggled per device). The defaults are attention-shaped:
a push should mean a human is needed. A decision is exactly that — Paperclip's
"choose an option, by this date" object — so `decision.created` and
`approval.created` lead the defaults, followed by an assignment wakeup (addressed
to a person) and a budget incident (an operator must act). Agent-activity and
new-task notifications are opt-in, because pushing them by default is how a
notification channel gets muted.

| Event | Notification |
| --- | --- |
| `decision.created` | "Decision needed" → `/<prefix>/decisions` |
| `decision.expired` (off by default) | "Decision overdue" → `/<prefix>/decisions` |
| `approval.created` | "Approval needed" → `/<prefix>/approvals/<id>` |
| `issue.assignment_wakeup_requested` | "Task assigned" → `/<prefix>/issues/<id>` |
| `agent.run.failed` (off by default) | "Agent run failed" → `/<prefix>/issues/<id>` |
| `budget.incident.opened` | "Budget threshold crossed" → `/<prefix>/activity/budgets` |
| `agent.run.failed` (off by default) | "Agent run failed" → `/<prefix>/issues/<id>` |
| `issue.created` (off by default) | "New task" → `/<prefix>/issues/<id>` |

**Targeting.** The activity log stamps events with `payload.responsibleUserId`.
When it is present, only that user's devices are notified — waking the whole
board for someone else's approval is the fastest way to get notifications muted.
That lookup is deliberately **not** company-scoped: a device registered while
looking at company A still receives what its owner is responsible for in company
B, because the device belongs to a person, not to a company. (On a multi-company
instance the company-scoped alternative silently drops every other company's
events, which reads as "notifications are broken".)

When no responsible user is named, the fallback **is** company-scoped: every
subscriber in that company who opted into that event type is notified, so an
unassigned budget incident in one company does not buzz another company's
subscribers.

**Throttle.** At most 12 pushes per device per 5 minutes. Suppressed pushes are
recorded with status `throttled`, so the settings page can explain the gap.

**Pruning.** A daily job (`0 4 * * *`) drops delivery rows older than 30 days and
devices that have failed at least 5 times and never once succeeded. Endpoints the
push service reports as gone (HTTP 404/410) are deleted immediately.

## Install

### Local path (development)

```bash
pnpm install
pnpm build
paperclipai plugin install /absolute/path/to/paperclip-plugin-webpush \
  --api-base http://127.0.0.1:3100
paperclipai plugin inspect conreo.webpush
```

The server must be able to read the path you pass: local-path installs are read
from the **server's** filesystem, not the CLI's.

### A remote or containerised instance

Two supported routes, depending on how the instance is deployed.

**A. Copy into the running container** (no compose change, no rebuild). Build the
portable artifact first — `scripts/bundle-deploy.sh` emits `dist/` +
`migrations/` + a flat production `node_modules` (~4 MB), because `web-push` is
resolved at runtime and cannot be bundled. It prints the absolute target path —
use that path, and delete stale copies of it, because an old bundle installs
cleanly and silently brings back fixed bugs:

```bash
./scripts/bundle-deploy.sh .cache/deploy-webpush

# stage on the host, then copy into the container's persistent volume
rsync -a --delete .cache/deploy-webpush/ <host>:/tmp/webpush/
ssh <host> 'sudo docker cp /tmp/webpush $(sudo docker ps -q -f name=server):/paperclip/plugins/webpush'

# install against the instance itself
paperclipai plugin install /paperclip/plugins/webpush \
  --api-base https://paperclip.example.ts.net
```

`/paperclip` is the instance's persistent volume, so the plugin survives
container restarts (but not volume deletion).

The path is resolved on the **server**, so the `paperclipai plugin install` step
can run from any machine that can reach the instance — the path only has to exist
inside the container. Authenticate the CLI against the instance once first:

```bash
paperclipai auth login --api-base https://paperclip.example.ts.net
```

**B. Bind mount + local path.** Add `- /opt/paperclip-plugins:/plugins:ro` to the
server service in your compose override and recreate the container. Use this when
you want to update the plugin by re-copying files rather than `docker cp`.

**C. npm package** (the upstream-blessed production artifact): publish to npm or
a private registry, then `paperclipai plugin install <package>@<version>`. The
container has `npm` available, so this works without any mount.

### Register a browser

Open the plugin's settings page. Reach it from the **Instance Settings → Plugins**
sidebar entry (the host builds that link itself), or by URL. The URL is keyed by
the plugin **record id**, not the plugin key — typing the key into the URL renders
the host's auto-generated configuration form instead of this plugin's UI:

```
https://<instance>/<companyPrefix>/company/settings/instance/plugins/<pluginRecordId>
```

`<companyPrefix>` is the company's issue prefix (e.g. `ACME`), and the record id is
shown by `paperclipai plugin inspect conreo.webpush` as `id=…`.

Click **Enable notifications**, allow the browser prompt, then **Send test
notification**. If the test arrives but board events do not, check that the
event's type is enabled for that device and that the device's delivery list does
not show `throttled`.

## Operations

```bash
paperclipai plugin list                      # status + version
paperclipai plugin inspect conreo.webpush    # full record, last error
paperclipai plugin health conreo.webpush     # registry/manifest/status checks
paperclipai plugin disable conreo.webpush    # pause without uninstalling
paperclipai plugin enable conreo.webpush     # resume
paperclipai plugin uninstall conreo.webpush  # remove install record
```

The settings page shows, per device: its event toggles, the last five delivery
attempts with HTTP status, and per-device test and remove buttons.

## Limitations

- **Decision notifications need a host that emits decision events.** The
  Decisions Desk logs `decision.created` (with `originIssueId`, `originAgentId`,
  `originResponsibleUserId`, and a `decide_by` deadline on `decision_triage`) but
  those actions were absent from `PLUGIN_EVENT_TYPES`, so the bus dropped them and
  no plugin could see a decision. That gap is fixed upstream in
  [paperclipai/paperclip#13306](https://github.com/paperclipai/paperclip/pull/13306);
  until the host carries it, the two decision toggles are simply inert. Nothing
  breaks in the meantime: the host's `events.subscribe` registers the pattern
  without validating it and matches it only against emitted events, so an
  unemitted trigger never fires and never errors — which is why the plugin
  registers it unconditionally instead of probing host capabilities.
- **The inbox is a derived view, not an event.** There is no "inbox item created"
  event; approvals and assignment wakeups are the inbox-addressed signals the event
  surface exposes, which is why they are the defaults.
- **iOS needs a standalone manifest.** See the requirements table.
- **VAPID keys are generated per instance and stored in the plugin namespace.**
  Rotating or deleting them invalidates every existing subscription; the
  settings page will then show `failed` deliveries with a 400/403 status and the
  device has to re-register (unsubscribe and Enable again).
- **Two frozen identifiers.** The database namespace is
  `plugin_<namespaceSlug>_<sha256(manifest.id)[0:10]>`, so changing `manifest.id`
  or `database.namespaceSlug` points the plugin at a different, empty schema.
- **Local-path rebuilds do not reload the worker by themselves.** After
  `pnpm build`, run `paperclipai plugin disable` then `enable` to restart it.
- **`web-push` cannot be bundled.** Keep it external and ship `node_modules`.
- Plain-HTTP origins get neither the service worker nor push, with no visible
  error.

## Development

```bash
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest: delivery logic, manifest, service-worker contract
pnpm build         # esbuild -> dist/worker.js, dist/manifest.js, dist/ui/
pnpm dev           # same, in watch mode
```

Four Playwright checks run against a live instance. They use persistent Chrome
profiles (`SPIKE_PROFILE_DIR` overrides per-check) because Chrome disables the
Push API in incognito contexts, and shared helpers in `scripts/lib/browser.mjs`:

```bash
node scripts/e2e-local.mjs          # permission -> subscribe -> real test push -> notification rendered
node scripts/e2e-event.mjs          # creates a real issue, expects a notification, deletes the issue
node scripts/e2e-approval.mjs       # creates an approval, expects "Approval needed", then rejects it
SPIKE_OTHER_COMPANY_ID=<id> SPIKE_OTHER_PREFIX=<PFX> \
  node scripts/e2e-cross-company.mjs  # event from a second company reaches a device registered in the first
```

Environmental overrides: `SPIKE_BASE_URL`, `SPIKE_COMPANY_PREFIX`, `SPIKE_COMPANY_ID`,
`SPIKE_PLUGIN_ID`, `SPIKE_CHROME_PATH`, `SPIKE_PROFILE_DIR`.

Three rules these checks follow, each learned from a false alarm that cost real
debugging time:

- **Assert an outcome, never an assumption.** They wait for the success notice and
  for the device card marked `This browser` — a stale row from an earlier run
  otherwise satisfies "a device is registered" instantly while this run's
  registration silently failed.
- **Delete the Chrome profile to test first use.** A registration persists in a
  profile, so only a fresh profile exercises the path a new operator takes (this
  is what surfaced the service-worker activation race that made the very first
  *Enable* click fail).
- **Expect the throttle.** Pushing more than 12 notifications to one device within
  5 minutes suppresses further ones, recorded as `throttled`. Every check uses its
  own profile for this reason, and `explainMiss()` reports a throttled device
  rather than leaving it looking like a delivery failure.

## Licence

MIT
