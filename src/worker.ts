import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_EVENT_TYPES,
  EVENT_TYPE_LABELS,
  activeUserMemberIds,
  agentIdOf,
  NOTIFIABLE_EVENT_TYPES,
  buildNotification,
  isNotifiableEventType,
  planDelivery,
  resolvePluginConfig,
  resolvePresentation,
  resolveVapidSubject,
  responsibleUserIdOf,
  shouldThrottle,
  type NotificationPayload,
  type NotificationPresentation,
  type SubscriptionTarget,
} from "./notifications.js";
import {
  countRecentDeliveries,
  deleteByEndpoint,
  deleteSubscription,
  ensureVapidKeypair,
  listEnabledForCompany,
  listEnabledForUser,
  listEnabledForUsers,
  listForUser,
  listRecentDeliveries,
  markDelivered,
  markFailed,
  pruneDeliveries,
  pruneNeverDelivered,
  recordDelivery,
  sendPush,
  updateSubscriptionPreferences,
  upsertSubscription,
  type PluginDb,
} from "./store.js";

/**
 * Membership is read from the host and cached briefly: it changes rarely, and the
 * fallback path consults it on every event that names nobody responsible.
 */
const MEMBERSHIP_TTL_MS = 5 * 60 * 1000;
const memberCache = new Map<string, { userIds: string[]; at: number }>();

/**
 * Agent display names, cached: a name changes rarely and the fan-out reads it on
 * every event an agent caused.
 */
const agentNameCache = new Map<string, string | null>();

async function agentName(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  const cacheKey = `${companyId}:${agentId}`;
  if (agentNameCache.has(cacheKey)) return agentNameCache.get(cacheKey) ?? null;
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    const name = agent?.name?.trim() || null;
    agentNameCache.set(cacheKey, name);
    return name;
  } catch (error) {
    ctx.logger.warn(`could not resolve agent ${agentId}: ${String(error)}`);
    return null;
  }
}

/** Flood control: at most this many pushes per device inside the window. */
const THROTTLE = { max: 12, windowMinutes: 5 };

/** How long the delivery ledger and never-delivered devices are kept. */
const RETENTION = { deliveryDays: 30, staleFailureCount: 5, staleDays: 7 };

/** Used when a subscription's origin is not an https origin (e.g. localhost dev). */
const FALLBACK_VAPID_SUBJECT = "mailto:webpush@paperclip.local";

/**
 * Company name and route prefix. Both change almost never and are read on every
 * event, so a process-local cache keeps the fan-out free of a host call per
 * notification.
 */
type CompanyInfo = { prefix: string | null; name: string | null };
const companyInfoCache = new Map<string, CompanyInfo>();

async function companyInfo(ctx: PluginContext, companyId: string): Promise<CompanyInfo> {
  const cached = companyInfoCache.get(companyId);
  if (cached) return cached;
  try {
    const company = await ctx.companies.get(companyId);
    const info: CompanyInfo = {
      prefix: company?.issuePrefix?.trim() || null,
      name: company?.name?.trim() || null,
    };
    companyInfoCache.set(companyId, info);
    return info;
  } catch (error) {
    ctx.logger.warn(`company lookup failed for ${companyId}: ${String(error)}`);
    return { prefix: null, name: null };
  }
}

/**
 * The company's operator configuration, resolved with working defaults.
 *
 * Read fresh on every use rather than cached: these events are low-frequency, and
 * a cached value would delay an operator's change with no visible reason. A
 * failure to read is not fatal — the defaults are what the plugin ships with.
 */
async function readConfig(ctx: PluginContext, companyId: string | null): Promise<unknown> {
  if (!companyId) return null;
  try {
    return await ctx.config.get(companyId);
  } catch (error) {
    ctx.logger.warn(`could not read plugin config for ${companyId}: ${String(error)}`);
    return null;
  }
}

/** Everything the fan-out needs about one company, from a single config read. */
async function companySettings(ctx: PluginContext, companyId: string | null) {
  const [raw, info] = await Promise.all([readConfig(ctx, companyId), companyId ? companyInfo(ctx, companyId) : null]);
  const resolved = info ?? { prefix: null, name: null };
  return {
    config: resolvePluginConfig(raw),
    presentation: resolvePresentation(raw, resolved.name),
    prefix: resolved.prefix,
  };
}

/**
 * Active human members of a company.
 *
 * Returns null when the host cannot answer, which is the signal to fall back to
 * the older company-scoped rule: a host without `access.members.read` must not
 * lose unassigned notifications entirely.
 */
async function companyMemberUserIds(
  ctx: PluginContext,
  companyId: string,
): Promise<string[] | null> {
  const cached = memberCache.get(companyId);
  if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) return cached.userIds;

  try {
    const members = await ctx.access.members.list({ companyId });
    const userIds = activeUserMemberIds(members);
    memberCache.set(companyId, { userIds, at: Date.now() });
    return userIds;
  } catch (error) {
    ctx.logger.warn(
      `could not read members of company ${companyId}; falling back to the company-scoped broadcast: ${String(error)}`,
    );
    return null;
  }
}

type PushSubscriptionJson = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

function parseSubscriptionInput(value: unknown): {
  endpoint: string;
  p256dh: string;
  auth: string;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as PushSubscriptionJson;
  const { endpoint, keys } = candidate;
  if (typeof endpoint !== "string" || endpoint.length === 0) return null;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/** Accept only origins usable as a VAPID subject (https) or as a display value. */
function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function sanitizeEventTypes(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && isNotifiableEventType(entry),
  );
}

function describeUserAgent(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim().slice(0, 250);
}

/**
 * Turn one subscription into the settings page's device row: what it receives,
 * whether it is healthy, and its last few delivery attempts.
 */
async function describeDevice(
  db: PluginDb,
  subscription: SubscriptionTarget,
): Promise<Record<string, unknown>> {
  const deliveries = await listRecentDeliveries(db, subscription.id, 5);
  return {
    endpoint: subscription.endpoint,
    eventTypes: subscription.eventTypes,
    enabled: subscription.enabled,
    origin: subscription.origin,
    deliveries,
  };
}

/** Fan one event out to the devices that should hear about it. */
async function fanOut(ctx: PluginContext, db: PluginDb, event: PluginEvent): Promise<void> {
  const settings = await companySettings(ctx, event.companyId);
  const config = settings.config;

  // The name is worth resolving only when something will use it: a template does
  // when it places the {{agent}} object, and the built-in wording always does for
  // an event about an agent.
  const agentId = agentIdOf(event);
  const templatesUseAgent = Object.values(settings.presentation.templates).some((template) =>
    `${template.title ?? ""}${template.body ?? ""}`.includes("{{agent}}"),
  );
  const usesBuiltInWording = !settings.presentation.templates[event.eventType];
  const agentNameForEvent =
    agentId && (templatesUseAgent || usesBuiltInWording)
      ? await agentName(ctx, event.companyId, agentId)
      : null;

  const notification = buildNotification(event, settings.prefix, settings.presentation, {
    agentName: agentNameForEvent,
  });
  if (!notification) return;

  const responsibleUserId = responsibleUserIdOf(event);

  // An event that names a responsible user goes to that person's devices in any
  // company. Otherwise it goes to the devices of the event company's members —
  // not to the devices that happened to be registered from that company, which is
  // an accident of where someone last clicked Enable rather than a preference.
  let broadcastSubscriptions: SubscriptionTarget[] = [];
  if (!responsibleUserId && config.notifyUnassignedEvents) {
    const memberUserIds = await companyMemberUserIds(ctx, event.companyId);
    broadcastSubscriptions =
      memberUserIds === null
        ? await listEnabledForCompany(db, event.companyId)
        : await listEnabledForUsers(db, memberUserIds);
  }

  const responsibleSubscriptions = responsibleUserId
    ? await listEnabledForUser(db, responsibleUserId)
    : [];

  const recipients = planDelivery({
    responsibleSubscriptions,
    broadcastSubscriptions,
    event,
    broadcastWhenUnassigned: config.notifyUnassignedEvents,
  });
  // No recipients is a normal outcome (nobody opted in, or nobody is responsible
  // for this event yet) — it is not an error, so it records no delivery row.
  if (recipients.length === 0) return;

  const vapid = await ensureVapidKeypair(db);

  for (const subscription of recipients) {
    const recent = await countRecentDeliveries(db, subscription.id, THROTTLE.windowMinutes);
    if (shouldThrottle(recent, { max: THROTTLE.max })) {
      await recordDelivery(db, {
        subscriptionId: subscription.id,
        eventId: notification.eventId,
        eventType: notification.eventType,
        status: "throttled",
        error: `over ${THROTTLE.max} pushes in ${THROTTLE.windowMinutes} minutes`,
      });
      continue;
    }

    const result = await sendPush({
      subscription,
      payload: notification satisfies NotificationPayload,
      vapid,
      subject: resolveVapidSubject(subscription.origin, FALLBACK_VAPID_SUBJECT),
    });

    if (result.ok) {
      await markDelivered(db, subscription.id);
      await recordDelivery(db, {
        subscriptionId: subscription.id,
        eventId: notification.eventId,
        eventType: notification.eventType,
        status: "delivered",
      });
      continue;
    }

    // 404/410 means the push service has forgotten this endpoint for good:
    // retrying can never succeed, so drop the row instead of leaking failures.
    if (result.statusCode === 404 || result.statusCode === 410) {
      await deleteByEndpoint(db, subscription.endpoint);
      continue;
    }

    await markFailed(db, subscription.id);
    await recordDelivery(db, {
      subscriptionId: subscription.id,
      eventId: notification.eventId,
      eventType: notification.eventType,
      status: "failed",
      httpStatus: result.statusCode ?? null,
      error: result.error ?? null,
    });
    ctx.logger.warn(
      `push failed for subscription ${subscription.id}: ${result.statusCode ?? "no status"} ${result.error ?? ""}`,
    );
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    const db = ctx.db as PluginDb;

    // Generate the VAPID keypair eagerly so the settings page always has a
    // public key to hand the browser, even before the first event fires.
    try {
      await ensureVapidKeypair(db);
    } catch (error) {
      ctx.logger.error(`could not ensure VAPID keypair: ${String(error)}`);
    }

    // The host validates nothing here — `events.subscribe` registers the pattern
    // and an event that never fires simply never matches — so subscribing to a
    // trigger the host does not emit yet is safe. The cast is only needed because
    // the installed SDK's event-name union lags the host for the decision
    // lifecycle (paperclipai/paperclip#13306); the runtime contract is a string.
    type SubscribableEvent = Parameters<PluginContext["events"]["on"]>[0];

    for (const eventType of NOTIFIABLE_EVENT_TYPES) {
      ctx.events.on(eventType as SubscribableEvent, async (event) => {
        try {
          await fanOut(ctx, db, event);
        } catch (error) {
          // A failed notification must never take the worker down: the next
          // event is independent, and the delivery ledger records the rest.
          ctx.logger.error(`fan-out failed for ${event.eventType}: ${String(error)}`);
        }
      });
    }

    /** Public client configuration: no secrets, safe for any board user. */
    ctx.data.register("client-config", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const [vapid, settings] = await Promise.all([
        ensureVapidKeypair(db),
        companySettings(ctx, companyId),
      ]);
      const config = settings.config;
      return {
        vapidPublicKey: vapid.publicKey,
        // The checkbox set is the company's configured default, so a saved change
        // is visible immediately and a new device starts with the intended set.
        eventTypes: NOTIFIABLE_EVENT_TYPES.map((type) => ({
          type,
          label: EVENT_TYPE_LABELS[type],
          defaultEnabled: config.defaultTriggers.includes(type),
        })),
        notifyUnassignedEvents: config.notifyUnassignedEvents,
        // Notification wording, so the settings page can show and edit what is saved.
        // The organization's own name is what the built-in wording prefixes, and
        // what the editor shows in its preview.
        organizationName: settings.presentation.organizationLabel,
        templates: settings.presentation.templates,
        throttle: THROTTLE,
      };
    });

    /**
     * Register this browser for the authenticated caller.
     *
     * Identity comes from the host-supplied actor context, never from action
     * params: the UI is same-origin app code and cannot be trusted to name the
     * user a device belongs to.
     */
    ctx.actions.register("register-subscription", async (params, context) => {
      const userId = context.actor.userId;
      const companyId = context.companyId ?? context.actor.companyId;
      if (!userId) throw new Error("A signed-in board user is required to enable notifications.");
      if (!companyId) throw new Error("An active company is required to enable notifications.");

      const subscription = parseSubscriptionInput(params.subscription);
      if (!subscription) throw new Error("A valid push subscription is required.");

      const config = (await companySettings(ctx, companyId)).config;

      await upsertSubscription(db, {
        userId,
        companyId,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        eventTypes: sanitizeEventTypes(params.eventTypes, config.defaultTriggers),
        label: typeof params.label === "string" ? params.label.slice(0, 100) : null,
        userAgent: describeUserAgent(params.userAgent),
        origin: normalizeOrigin(params.origin),
      });

      const devices = await listForUser(db, userId);
      return { devices: await Promise.all(devices.map((device) => describeDevice(db, device))) };
    });

    ctx.actions.register("update-subscription", async (params, context) => {
      const userId = context.actor.userId;
      const companyId = context.companyId ?? context.actor.companyId;
      if (!userId || !companyId) throw new Error("A signed-in board user and company are required.");
      if (typeof params.endpoint !== "string") throw new Error("endpoint is required.");

      await updateSubscriptionPreferences(db, {
        userId,
        endpoint: params.endpoint,
        // A device may opt into any trigger, not only the organization defaults,
        // so the fallback here is the full set — it is only reached if the caller
        // sent something that is not a list at all.
        eventTypes: Array.isArray(params.eventTypes)
          ? sanitizeEventTypes(params.eventTypes, NOTIFIABLE_EVENT_TYPES)
          : undefined,
        enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
      });

      const devices = await listForUser(db, userId);
      return { devices: await Promise.all(devices.map((device) => describeDevice(db, device))) };
    });

    ctx.actions.register("remove-device", async (params, context) => {
      const userId = context.actor.userId;
      const companyId = context.companyId ?? context.actor.companyId;
      if (!userId || !companyId) throw new Error("A signed-in board user and company are required.");
      if (typeof params.endpoint !== "string") throw new Error("endpoint is required.");

      await deleteSubscription(db, { userId, endpoint: params.endpoint });
      const devices = await listForUser(db, userId);
      return { devices: await Promise.all(devices.map((device) => describeDevice(db, device))) };
    });

    ctx.actions.register("list-devices", async (_params, context) => {
      const userId = context.actor.userId;
      const companyId = context.companyId ?? context.actor.companyId;
      if (!userId || !companyId) return { devices: [] };

      const devices = await listForUser(db, userId);
      return { devices: await Promise.all(devices.map((device) => describeDevice(db, device))) };
    });

    /**
     * Send a test push to the caller's own devices only — the quickest way for
     * an operator to separate "the pipeline is broken" from "that event never
     * happened".
     */
    ctx.actions.register("send-test", async (params, context) => {
      const userId = context.actor.userId;
      const companyId = context.companyId ?? context.actor.companyId;
      if (!userId || !companyId) throw new Error("A signed-in board user and company are required.");

      const devices = await listForUser(db, userId);
      const vapid = await ensureVapidKeypair(db);
      const payload: NotificationPayload = {
        eventType: "plugin.test",
        eventId: `test-${Date.now()}`,
        title: "Paperclip notifications are on",
        body: "This is a test push from the Web Push Notifications plugin.",
        url: "/",
        tag: "webpush-test",
      };

      const results: { endpoint: string; ok: boolean; statusCode?: number; error?: string }[] = [];
      for (const device of devices) {
        // An explicit endpoint means "test this one device"; otherwise test all.
        if (typeof params.endpoint === "string" && params.endpoint !== device.endpoint) continue;
        const result = await sendPush({
          subscription: device,
          payload,
          vapid,
          subject: resolveVapidSubject(device.origin, FALLBACK_VAPID_SUBJECT),
        });
        if (result.ok) {
          await markDelivered(db, device.id);
        } else if (result.statusCode === 404 || result.statusCode === 410) {
          await deleteByEndpoint(db, device.endpoint);
        } else {
          await markFailed(db, device.id);
        }
        await recordDelivery(db, {
          subscriptionId: device.id,
          eventId: payload.eventId,
          eventType: payload.eventType,
          status: result.ok ? "delivered" : result.statusCode === 404 || result.statusCode === 410 ? "gone" : "failed",
          httpStatus: result.statusCode ?? null,
          error: result.error ?? null,
        });
        results.push({
          endpoint: device.endpoint,
          ok: result.ok,
          statusCode: result.statusCode,
          error: result.error,
        });
      }

      const remaining = await listForUser(db, userId);
      return {
        results,
        devices: await Promise.all(remaining.map((device) => describeDevice(db, device))),
      };
    });

    ctx.jobs.register("prune-subscriptions", async (job) => {
      const deliveries = await pruneDeliveries(db, RETENTION.deliveryDays);
      const stale = await pruneNeverDelivered(
        db,
        RETENTION.staleFailureCount,
        RETENTION.staleDays,
      );
      ctx.logger.info(
        `prune run ${job.runId}: removed ${deliveries} delivery rows, ${stale} never-delivered subscriptions`,
      );
    });
  },

  async onHealth() {
    return { status: "ok", message: "Web Push Notifications worker is running" };
  },
});

export default plugin;

runWorker(plugin, import.meta.url);
