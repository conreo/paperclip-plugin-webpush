# Paperclip Web Push Notifications

Real desktop and Android notifications for Paperclip, delivered as a standalone
plugin. No Paperclip fork, no core changes, no image rebuild.

Someone asks for a decision, an approval lands in your inbox, a task is handed to
you, or a budget threshold trips — and your computer tells you, even when the
Paperclip tab is closed.

- **Nothing to configure to start.** The plugin generates its own signing key and
  registers your browser on one click.
- **Addressed to people, not companies.** A device registered in one organization
  still receives what you are responsible for in another.
- **Quiet by design.** Only attention-worthy events are on by default, at most 12
  notifications per device per 5 minutes.

---

## Quick start

**1. Install the plugin** (an instance admin, once):

*Paperclip board → **Instance Settings → Plugins → Install*** → enter the package
name `paperclip-plugin-webpush` → **Install**. That is the whole step.

Or from a terminal:

```bash
paperclipai auth login --instance-admin --api-base https://paperclip.example.ts.net
paperclipai plugin install paperclip-plugin-webpush --api-base https://paperclip.example.ts.net
paperclipai plugin inspect conreo.webpush     # expect status=ready
```

**2. Turn it on in your browser** (each person, each browser):

*Instance Settings → Plugins → Web Push Notifications* → **Enable notifications**
→ allow the browser prompt. An **HTTPS** origin is required; `localhost` works for
testing.

**3. Prove it works:**

Click **Send test notification**. A test notification should appear within a
second or two. Then do something real — create an approval — and a "Approval
needed" notification should arrive with a link straight to it.

---

## Install

### Option 1 — npm package (recommended)

The published package is the supported production artifact. The host installs it
with `npm install`, so dependencies such as `web-push` are fetched for you and no
`node_modules` has to travel with the plugin.

Requirements on the host: **npm available at runtime** and **network access to the
registry**. Both are true of the standard Docker image.

Installing from the board needs **instance admin** rights. Installing from the CLI
needs an instance-admin credential:

```bash
paperclipai auth login --instance-admin --api-base https://paperclip.example.ts.net
paperclipai plugin install paperclip-plugin-webpush --api-base https://paperclip.example.ts.net
```

A plain board login is rejected with *"Instance admin access required"* — that is
the `assertInstanceAdmin` check on the install route, not a plugin problem.

Where it lands: `~/.paperclip/plugins`, which in the standard container is
`/paperclip/.paperclip/plugins` — inside the persistent volume, so an npm-installed
plugin survives container restarts and recreation.

**Update:** install a newer version by name, for example
`paperclipai plugin install paperclip-plugin-webpush@0.6.0`, or use the board's
Plugins page. An upgrade that adds capabilities is held as `upgrade_pending` until
an operator approves the new set.

**Publish your own build** (only if you forked it): see
[Publishing](#publishing) — npm requires 2FA for publishing, which is the most
common obstacle.

### Option 2 — local path (private builds, development)

Use this when the code must not leave your machines. The path is read from the
**server's** filesystem, not the CLI's, so the directory only has to exist inside
the container.

```bash
# 1. build the portable artifact (dist/ + migrations/ + a flat node_modules)
./scripts/bundle-deploy.sh
#    -> prints an absolute target path, e.g. .../paperclip-plugin-webpush/.cache/deploy-webpush

# 2. copy it to the host, then into the container's persistent volume
rsync -a --delete <bundle-path>/ <host>:/tmp/webpush/
ssh <host> 'sudo docker exec <server-container> mkdir -p /paperclip/plugins'
ssh <host> 'sudo docker cp /tmp/webpush <server-container>:/paperclip/plugins/webpush'
ssh <host> 'sudo docker exec <server-container> chmod -R a+rX /paperclip/plugins/webpush'

# 3. install it (from anywhere that can reach the instance)
paperclipai auth login --instance-admin --api-base https://paperclip.example.ts.net
paperclipai plugin install /paperclip/plugins/webpush --api-base https://paperclip.example.ts.net
```

Local-path installs are trusted code from disk: the server executes the worker
directly, so only install a path you built yourself.

Two traps worth knowing:

- **`node_modules` must be shipped** for a local-path install, because `web-push`
  is resolved at runtime. It cannot be bundled into the worker — bundling it makes
  the forked worker exit immediately with `Dynamic require of "crypto" is not
  supported`. `scripts/bundle-deploy.sh` handles this and normalizes permissions,
  because a hand-copied `package.json` at mode `600` installs fine as root and
  fails for any other user.
- **Use the bundle path the script prints.** A stale bundle elsewhere in the tree
  installs cleanly and silently restores bugs you already fixed.

---

## Turn on notifications

Open **Instance Settings → Plugins → Web Push Notifications**. Prefer that sidebar
entry over typing a URL: the settings page is addressed by the plugin's **record
id**, and putting the plugin *key* in the URL renders Paperclip's auto-generated
configuration form instead — which looks like the plugin has no settings page.

```
https://<instance>/<companyPrefix>/company/settings/instance/plugins/<pluginRecordId>
```

`<companyPrefix>` is your company's issue prefix, and the record id is the `id=…`
shown by `paperclipai plugin inspect conreo.webpush`.

Click **Enable notifications**. The page shows, per device:

- **This browser** versus other devices you registered elsewhere
- a checkbox per trigger (see the table below)
- the last five delivery attempts with HTTP status — the honest answer to "why
  didn't I get that?"
- **Test this device** and **Remove**

Notifications are delivered by the browser's own push service, to the service
worker this plugin registers. That is what makes them arrive with the tab closed.

---

## What you get notified about

Defaults are attention-shaped: a push should mean a human is needed. A decision is
exactly that, so it leads, followed by approvals and assignment wakeups (both
inbox-addressed) and budget incidents (an operator has to act).

| Trigger | Notification | Default |
| --- | --- | --- |
| `decision.created` | "Decision needed" → `/<prefix>/decisions` | on |
| `approval.created` | "Approval needed" → `/<prefix>/approvals/<id>` | on |
| `issue.assignment_wakeup_requested` | "Task assigned" → `/<prefix>/issues/<id>` | on |
| `budget.incident.opened` | "Budget threshold crossed" → `/<prefix>/activity/budgets` | on |
| `decision.expired` | "Decision overdue" → `/<prefix>/decisions` | off |
| `agent.run.failed` | "Agent run failed" → `/<prefix>/issues/<id>` | off |
| `issue.created` | "New task" → `/<prefix>/issues/<id>` | off |

Agent-activity and new-task notifications are opt-in: pushing them by default is
how a notification channel gets muted.

### Who receives a notification

- **An event that names a responsible user** goes to that user's devices, in
  **any** company. A device registered while looking at one organization still
  receives what its owner is responsible for in another, because a device belongs
  to a person.
- **An event that names nobody responsible** goes to the devices of that
  organization's **active human members** who opted into that trigger. Agent
  members are excluded, as are pending and suspended members. It does not reach
  other organizations' subscribers.
- If the host cannot answer the membership question, the plugin falls back to a
  company-scoped broadcast rather than dropping the notification.
- Deep links always carry the event's own company prefix, so a notification from
  one organization opens that organization.

Preferences are per **device**, not per organization: one toggle set and one
throttle, shared across the organizations you belong to.

### Fullscreen button

The plugin adds a **fullscreen toggle to the toolbar** (next to the breadcrumbs) that
requests an immersive window: no address bar, and on Android no status or navigation
bars until you swipe from an edge.

This exists because a privately hosted Paperclip often *cannot* be installed as an
app. Android Chrome builds installed PWAs (WebAPKs) with Google's server-side minting
service, which has to fetch the manifest and icons over the public internet — a
tailnet-only or otherwise private origin is unreachable to it, so Chrome silently
falls back to a plain shortcut, and a shortcut always opens with browser chrome no
matter what the manifest requests. On such a deployment the toggle is the way to get
the space back.

Limits, so they are not surprises:

- It is the browser's Fullscreen API, not an installed-app display mode. The bars
  return when the page reloads or you swipe from an edge.
- `matchMedia("(display-mode: fullscreen)")` stays **false** — that query describes
  installed apps, and this is a different mechanism.
- The button hides itself where the API is unavailable, rather than offering a button
  that cannot work.

If your instance *is* reachable publicly, the manifest change is the better route: it
gives a genuinely installed, always-fullscreen app **and** push notifications.

### Configuration

Two settings are configurable, per organization, on the plugin's settings page:

| Setting | What it does |
| --- | --- |
| **Triggers for newly enabled browsers** | Which notifications a browser starts with. Each device can still change its own set afterwards. |
| **Notify about events that name nobody responsible** | When off, only events that name a responsible user notify anyone — unassigned events such as an ownerless budget incident notify nobody. |

Both live in Paperclip's own company-scoped plugin configuration, which means
**saving them requires an instance admin**. That is deliberate: the alternative,
plugin-owned state, could be written by any board member through a plugin action.

The settings page reads them back through the worker, so a saved change is visible
immediately and applies to browsers enabled from then on.

**Notification wording** is editable in the same section, per trigger: a title and a
body, each composed of text and **objects**. An empty field keeps the built-in wording,
which the field shows as its placeholder.

An object is the value from the event — the organization, the agent, the task
identifier, the task title, the approval type, the budget scope, the failed run. You do
not type one: you insert it from the list, and it becomes an atomic chip you can move or
remove. That is the whole point: a message can never contain a misspelled object, and
the object list only offers the ones the trigger actually has a value for (`{{type}}`
exists for approvals, `{{identifier}}` does not).

- **Insert** — the `+` at the right of a field lists the objects available to that
  trigger, with a description of each. The object lands where your cursor was.
- **Reorder** — the `‹` and `›` on a chip swap it with the neighbouring object, so the
  words between them stay put: "{{title}} for {{org}}" becomes "{{org}} for {{title}}",
  not "{{org}}{{title}} for". `×` removes it.
- **What you see is what is sent** — a preview under each trigger shows the message with
  its objects filled in, always, not only once you have customised something. Deleting
  both fields puts the built-in wording back.

Two rules follow from that promise, and both were chosen deliberately:

- **A custom title is never prefixed.** The organization name is prefixed to the *built-in*
  wording, because that is what an operator who never opens the editor gets. Once you
  write a title, it is sent exactly as the preview shows it — insert `{{org}}` where you
  want the name. (An earlier version prefixed custom titles too and skipped the prefix
  only when it saw `{{org}}` in the text, which made the preview a lie.)
- **Objects that an event has no value for render as nothing.** An approval has no task
  identifier, so `{{identifier}}` in an approval's body disappears rather than leaving
  `{{identifier}}` in a notification somebody reads.

Objects are filled in when the notification is sent: `{{org}}` and `{{agent}}` for every
trigger, plus `{{identifier}}` and `{{title}}` for new tasks, `{{type}}` for approvals,
`{{scope}}` for budget incidents, and `{{run}}` for failed runs. The agent's name is
resolved from the host rather than carried in the event.

There is deliberately no switch for the organization name or the agent's name: both are
objects now, so a switch would have been a second way to say the same thing, and the one
that fires behind your back.

The omissions are deliberate rather than unfinished:

- **The throttle (12 per device per 5 minutes) is not configurable**, because it
  counts a device across organizations. A per-organization value would be a lie,
  and making it truly per-organization needs a company column on every delivery
  row.
- **The retention window (30 days) is not configurable**, because the prune job
  that uses it runs without any company context.
- **The VAPID keypair and its subject fallback are per instance**, not per
  organization, so there is nowhere meaningful to configure them per company.

### Rate limiting

At most **12 notifications per device per 5 minutes**. Anything beyond that is
suppressed and recorded as `throttled`, visible per device on the settings page,
so a burst shows up as a rate limit rather than as silence.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Test notification never arrives | Permission not granted, or the origin is not a secure context | Check the header line on the settings page: it must say **HTTPS origin** and `permission: granted`. Plain `http://<lan-ip>` origins get no push at all, silently. |
| Settings page shows the auto-generated form, not this plugin's UI | The URL used the plugin key instead of the record id | Open it from the **Instance Settings → Plugins** sidebar entry, or use the `id=` from `paperclipai plugin inspect conreo.webpush`. |
| Test works, but approvals never arrive | The device does not want that trigger, or you are not the responsible user | Tick the trigger for that device, and check the company's *default responsible user*. Approvals are targeted at `responsibleUserId`. |
| Delivery list shows `throttled` | More than 12 pushes to that device in 5 minutes | Wait 5 minutes. This is working as intended. |
| Delivery list shows `failed` with 400/403 | The subscription was created against a different VAPID keypair (for example after the plugin's namespace was recreated) | **Turn off for this browser**, then **Enable notifications** again to re-subscribe. |
| Plugin shows `status=error` | Worker failed to start — usually a local-path install without `node_modules` | `paperclipai plugin inspect conreo.webpush` shows `last_error`; reinstall with `scripts/bundle-deploy.sh` output. |
| Nothing at all, and no device is listed | Nobody has clicked Enable in this browser yet | Do step 2 of the quick start. |
| Board shows *Instance admin access required* on install | The credential is a plain board login | Re-run `paperclipai auth login --instance-admin`. |
| iOS: no notifications | Safari only delivers Web Push to a site added to the Home Screen, with a standalone-window manifest | Out of scope: Paperclip ships `display: "browser"`. Desktop and Android are unaffected. |

---

## Verify an installation

Everything here is read-only.

```bash
# on the instance host: registry row, namespace tables, devices, VAPID keypair, delivery ledger
ssh <host> 'bash -s' < scripts/verify-install.sh

# the plugin's service worker is served on your real origin (a browser needs this to register it)
curl -sI https://<instance>/_plugins/<pluginRecordId>/ui/sw.js | head -3
#  expect: 200, content-type: application/javascript; charset=utf-8
```

Or query the plugin's own namespace directly. It is derived from the plugin id, so
it has the same name everywhere:

```sql
select user_id, company_id, enabled, array_length(event_types, 1) as triggers,
       created_at from plugin_webpush_7d3a6286ba.push_subscription;

select status, event_type, http_status, created_at
  from plugin_webpush_7d3a6286ba.push_delivery
 order by created_at desc limit 10;
```

A healthy installation has one VAPID keypair, one subscription row per browser that
enabled notifications, and `delivered` rows whenever something was pushed.

---

## Requirements

| Requirement | Why |
| --- | --- |
| **HTTPS** origin (or `localhost`) | Service workers and the Push API exist only in a secure context. `tailscale serve`, a TLS terminator, or any real certificate works. |
| Chrome, Edge, Firefox, or Android Chrome | Standard Web Push. Verified end to end on Chrome against Google's push service. |
| iOS: Safari 16.4+ **and** Add to Home Screen | iOS delivers Web Push only to a Home Screen web app whose manifest requests a standalone window. Paperclip ships `display: "browser"`, so **iOS is out of scope**. |
| Host: npm + registry access | Only for npm-package installs. Local-path installs instead need `node_modules` shipped. |
| Plugin capability `access.members.read` | Used to resolve who belongs to an organization, for events that name nobody responsible. |
| Plugin capability `ui.action.register` | Renders the fullscreen toolbar button. |
| Plugin capability `agents.read` | Resolves the display name of the agent a notification is about. |

---

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

1. **Worker** (`src/worker.ts`, a forked Node process) subscribes to the triggers,
   decides who should hear about each event, and sends the push.
2. **Settings page** (`src/ui/SettingsPage.tsx`) runs same-origin inside the board:
   it asks for permission on an explicit click, registers the service worker,
   creates the `PushSubscription`, and manages devices and toggles.
3. **Service worker** (`src/ui/sw.js`) is served as a static file from the plugin's
   UI directory and handles `push` and `notificationclick`.

The service worker is registered at `/_plugins/<pluginId>/ui/sw.js`, with its scope
limited to that directory. It **coexists** with Paperclip's own root-scoped
`/sw.js` instead of replacing it, and registers no `fetch` listener, so it cannot
interfere with the app's offline behaviour.

It also records the last push it showed, in its own Cache API cache, and answers a
`last-push` message from the settings page. That exists because "did the message I
composed actually arrive, and what did it say?" is otherwise unanswerable from the app:
the notification lives in the OS, and `getNotifications()` reports nothing in a headless
browser even when the delivery succeeded. A variable would not do — the browser stops an
idle worker after a few tens of seconds, which is exactly when someone goes looking.

Because a plugin is served under `/_plugins/<record id>/ui/`, reinstalling one mints a new
record id and leaves the previous worker registered. Chrome keeps **one push subscription
per origin**, attached to the registration that created it, so the orphaned worker would
keep receiving every push while the current build saw nothing. Enabling notifications
therefore unregisters this plugin's stale workers (and releases their subscription) before
registering the current one; the app's root-scoped worker is never touched.

### Styling

The settings page is meant to be indistinguishable from Paperclip's own Company
Settings page, and getting there has two constraints:

- a plugin may not import host components, and
- Tailwind only generates the classes the host's own sources use, so writing
  `text-xs` or `rounded-md` in plugin code would produce no CSS at all.

So `src/ui/styles.ts` reimplements the handful of primitives that page is built
from — its `Field`/`ToggleField` rows, `ToggleSwitch` and the `sm` Button variants —
against the host's own CSS variables, and injects them as a scoped stylesheet
(`.pcp-*`, once per document, so the settings page and the toolbar button can both
ask for it). A stylesheet rather than inline styles is what makes hover, focus
rings, the disabled state and the dark-mode switch thumb expressible at all.

The values are copied from the host sources literally, including details that are
easy to miss: the switch is the status green (`--status-task-done`) rather than
`--primary`, its thumb is an oblong moved with the `translate` property (Tailwind
v4's `translate-x-4`, not `transform`), and the `text-*` utilities each carry a
line-height, without which every control is a pixel or two taller than the host's.

`scripts/compare-ui.mjs` verifies this rather than asserting it: it measures the
host page and the plugin page in the same browser and prints a property-by-property
diff, including resolving each token through the browser to compare colours.

### Where the values come from

A trigger's wording is built from the event: the activity action names the trigger, and the
activity's details supply the values its objects can use. The host spreads those details
**flat onto the plugin event's payload** (`{ ...redactedDetails, agentId, runId,
responsibleUserId }`), so they are read from the payload root, with a nested `details`
object accepted as a fallback. Reading only `payload.details.*` is worth knowing about: it
never misses loudly, it just silently falls back to the generic wording, and the settings
preview — which fills objects with samples — keeps showing a value.

### Data

Subscriptions live in the plugin's own PostgreSQL namespace, never in core tables:

- `push_subscription` — one row per browser profile, keyed by the push service
  endpoint, so re-enabling a browser updates in place instead of stacking rows.
- `push_delivery` — one row per attempt: the throttle ledger and the "why didn't I
  get that?" trail shown on the settings page.
- `vapid_keypair` — the instance's signing keypair, generated on first use. One per
  instance, not per organization.

A daily job (`0 4 * * *`) drops delivery rows older than 30 days and devices that
failed at least five times and never once succeeded. Endpoints the push service
reports as gone (HTTP 404/410) are deleted immediately.

## Operations

```bash
paperclipai plugin list                      # status + version
paperclipai plugin inspect conreo.webpush    # full record, including last error
paperclipai plugin health conreo.webpush     # registry / manifest / status checks
paperclipai plugin disable conreo.webpush    # pause without uninstalling
paperclipai plugin enable conreo.webpush     # resume
paperclipai plugin uninstall conreo.webpush  # remove the install record
```

## Limitations

- **Decision notifications need a host that emits decision events.** The Decisions
  Desk logs `decision.created` with exactly the payload a notifier needs, but those
  actions were missing from `PLUGIN_EVENT_TYPES`, so the event bus dropped them.
  Fixed upstream in [paperclipai/paperclip#13306](https://github.com/paperclipai/paperclip/pull/13306);
  on an older host the two decision toggles are inert. Nothing breaks meanwhile —
  an unemitted trigger never fires and never errors.
- **The inbox is a view, not an event.** Paperclip exposes no "inbox item created"
  event, so approvals and assignment wakeups are the inbox-addressed signals
  available, which is why they are defaults.
- **iOS needs a standalone manifest.** See Requirements.
- **VAPID keys are per instance.** Rotating or losing them invalidates every
  subscription; devices then report `failed` and must re-enable.
- **Two frozen identifiers.** The namespace is
  `plugin_<namespaceSlug>_<sha256(manifest.id)[0:10]>`, so changing `manifest.id` or
  `database.namespaceSlug` points the plugin at a different, empty schema.
- **Local-path rebuilds do not restart the worker.** After `pnpm build`, run
  `paperclipai plugin disable` then `enable`.
- **Each browser profile is its own device.** Deleting a profile leaves its row
  behind; use **Remove** on the settings page.

---

## Development

```bash
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest: delivery logic, manifest contract, service worker contract
pnpm build         # esbuild -> dist/worker.js, dist/manifest.js, dist/ui/
pnpm dev           # same, in watch mode
```

Six browser-driven checks run against a live instance. They use persistent Chrome
profiles (`SPIKE_PROFILE_DIR` overrides per check) because Chrome disables the Push
API in incognito contexts, and shared helpers in `scripts/lib/browser.mjs`:

```bash
node scripts/e2e-local.mjs      # permission -> subscribe -> real test push -> notification rendered
node scripts/e2e-event.mjs      # creates a real issue, expects a notification, deletes the issue
node scripts/e2e-approval.mjs   # creates an approval, expects "Approval needed", then rejects it
SPIKE_OTHER_COMPANY_ID=<id> SPIKE_OTHER_PREFIX=<PFX> \
  node scripts/e2e-cross-company.mjs   # an event from a second company reaches a device registered in the first
node scripts/e2e-config.mjs     # saves organization defaults, reloads, and proves a new browser uses them
node scripts/e2e-template.mjs   # composes a message from objects, reorders it, saves, reloads, and
                                # expects a real approval to arrive with exactly that wording
```

Overrides: `SPIKE_BASE_URL`, `SPIKE_COMPANY_PREFIX`, `SPIKE_COMPANY_ID`,
`SPIKE_PLUGIN_ID`, `SPIKE_CHROME_PATH`, `SPIKE_PROFILE_DIR`.

Styling is checked without a browser suite of its own, because a screenshot only
answers "does this look right" for a human eye:

```bash
node scripts/compare-ui.mjs     # measures the host's Company Settings primitives and
                                # the plugin page in one browser, then prints a diff
```

It is read-only, and it reports the properties that would otherwise be judged by
eye: font sizes and line-heights, control heights, padding, radius, and each colour
resolved through the browser so it can be compared to the host's token.

Three rules these checks follow, each learned from a false alarm that cost real
debugging time:

- **Assert an outcome, never an assumption.** They wait for the device card marked
  *This browser*. A stale row from an earlier run otherwise satisfies "a device is
  registered" instantly while this run's registration silently failed.
- **Assert that outcome on state, not on wording.** A section is *labelled* "This
  browser" and its description contains the word "registered", so matching text
  there passes whether or not anything happened; both checks look for the device
  card itself.
- **Delete the Chrome profile to test first use.** A registration persists in a
  profile, so only a fresh profile exercises the path a new operator takes. This is
  what surfaced the service-worker activation race that made the very first
  *Enable* click fail.
- **Expect the throttle.** More than 12 pushes to one device in 5 minutes are
  suppressed and recorded as `throttled`; `explainMiss()` reports that instead of
  leaving it looking like a delivery failure. Repeated runs against one profile hit this
  for real, so a check that suddenly sees no push is usually the flood control working:
  use a fresh `SPIKE_PROFILE_DIR`.
- **Wait for the worker you mean.** A changed `sw.js` only takes over after an update
  check, and a reinstall leaves the previous worker registered, so a check has to resolve
  the registration belonging to the plugin id the page was served from — otherwise it
  asks a dead build and reads silence as a failure.

### Publishing

Maintainers only. The package ships prebuilt output on purpose: the host installs
with `npm install <spec> --ignore-scripts`, so nothing is compiled on the target —
the tarball must already contain `dist/`.

```bash
npm login
npm publish              # prepublishOnly runs pnpm build && pnpm test
npm view paperclip-plugin-webpush version
```

npm refuses to publish without a second factor when the account has 2FA enabled:
*"Two-factor authentication or granular access token with bypass 2fa enabled is
required to publish packages."* Either pass a current code
(`npm publish --otp=123456`), or create a **granular access token** with
**Read and write** on **All packages** and **Bypass two-factor authentication**
ticked. Choose *All packages*, not a single package: a token restricted to named
packages cannot create a package that does not exist yet.

## Licence

MIT
