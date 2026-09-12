import webpush from "web-push";
import type { SubscriptionTarget } from "./notifications.js";

/**
 * The narrow slice of `ctx.db` this module uses. Declaring it explicitly keeps
 * the SQL layer testable without a host plugin context.
 *
 * Runtime SQL is namespace-scoped by the host: `query` must be a single SELECT
 * and `execute` a single INSERT/UPDATE/DELETE, and every table reference must
 * be qualified with the plugin's own namespace (`ctx.db.namespace`). Reads from
 * `information_schema` are rejected, which is why nothing here introspects.
 */
export type PluginDb = {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  company_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  event_types: string[] | null;
  enabled: boolean;
  origin: string | null;
};

function toTarget(row: SubscriptionRow): SubscriptionTarget {
  return {
    id: row.id,
    userId: row.user_id,
    companyId: row.company_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    eventTypes: row.event_types ?? [],
    enabled: row.enabled,
    origin: row.origin,
  };
}

const SUBSCRIPTION_COLUMNS =
  "id, user_id, company_id, endpoint, p256dh, auth, event_types, enabled, origin";

/** Every enabled subscription for a company — the fan-out candidate set. */
export async function listEnabledForCompany(
  db: PluginDb,
  companyId: string,
): Promise<SubscriptionTarget[]> {
  const rows = await db.query<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from ${db.namespace}.push_subscription
      where company_id = $1 and enabled = true`,
    [companyId],
  );
  return rows.map(toTarget);
}

/**
 * Every enabled device belonging to one user, in any company.
 *
 * Delivery for a named responsible user is user-scoped, not company-scoped: the
 * device is a browser, and the person is the same person in every company.
 */
export async function listEnabledForUser(
  db: PluginDb,
  userId: string,
): Promise<SubscriptionTarget[]> {
  const rows = await db.query<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from ${db.namespace}.push_subscription
      where user_id = $1 and enabled = true`,
    [userId],
  );
  return rows.map(toTarget);
}

/**
 * Enabled devices belonging to any of `userIds`, in any company.
 *
 * Used for the unassigned-event fallback, where the eligible owners are the
 * active members of the event's company rather than the devices that happen to
 * have been registered from it.
 */
export async function listEnabledForUsers(
  db: PluginDb,
  userIds: readonly string[],
): Promise<SubscriptionTarget[]> {
  if (userIds.length === 0) return [];
  const rows = await db.query<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from ${db.namespace}.push_subscription
      where enabled = true and user_id = any(string_to_array($1, ','))`,
    [userIds.join(",")],
  );
  return rows.map(toTarget);
}

/** Every enabled subscription, regardless of company — used by the prune job. */
export async function listAllEnabled(db: PluginDb): Promise<SubscriptionTarget[]> {
  const rows = await db.query<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from ${db.namespace}.push_subscription where enabled = true`,
  );
  return rows.map(toTarget);
}

/**
 * A user's own devices, enabled or not, for the settings page — across every
 * company, so the page can say "this browser" no matter which company's settings
 * it was registered from.
 */
export async function listForUser(db: PluginDb, userId: string): Promise<SubscriptionTarget[]> {
  const rows = await db.query<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from ${db.namespace}.push_subscription
      where user_id = $1
      order by created_at asc`,
    [userId],
  );
  return rows.map(toTarget);
}

export type UpsertSubscriptionInput = {
  userId: string;
  companyId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  eventTypes: string[];
  label?: string | null;
  userAgent?: string | null;
  origin?: string | null;
};

/**
 * Register (or re-register) a browser.
 *
 * `endpoint` is the push service URL and is unique per browser profile, so it
 * is the conflict key: a re-subscribe after a permission reset updates the keys
 * in place instead of stacking duplicate devices. Re-registering also clears
 * the failure counter and re-enables a previously disabled device.
 */
export async function upsertSubscription(
  db: PluginDb,
  input: UpsertSubscriptionInput,
): Promise<void> {
  await db.execute(
    `insert into ${db.namespace}.push_subscription
       (user_id, company_id, endpoint, p256dh, auth, event_types, label, user_agent, origin, enabled, updated_at)
     values ($1, $2, $3, $4, $5, string_to_array($6, ','), $7, $8, $9, true, now())
     on conflict (endpoint) do update set
       user_id = excluded.user_id,
       company_id = excluded.company_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       event_types = excluded.event_types,
       label = excluded.label,
       user_agent = excluded.user_agent,
       origin = excluded.origin,
       enabled = true,
       failure_count = 0,
       updated_at = now()`,
    [
      input.userId,
      input.companyId,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.eventTypes.join(","),
      input.label ?? null,
      input.userAgent ?? null,
      input.origin ?? null,
    ],
  );
}

/** Change which event types a device receives, and/or enable-disable it. */
export async function updateSubscriptionPreferences(
  db: PluginDb,
  input: { userId: string; endpoint: string; eventTypes?: string[]; enabled?: boolean },
): Promise<number> {
  const assignments: string[] = ["updated_at = now()"];
  const params: unknown[] = [input.userId, input.endpoint];

  if (input.eventTypes) {
    params.push(input.eventTypes.join(","));
    assignments.push(`event_types = string_to_array($${params.length}, ',')`);
  }
  if (typeof input.enabled === "boolean") {
    params.push(input.enabled);
    assignments.push(`enabled = $${params.length}`);
  }

  const result = await db.execute(
    `update ${db.namespace}.push_subscription set ${assignments.join(", ")}
      where user_id = $1 and endpoint = $2`,
    params,
  );
  return result.rowCount;
}

/**
 * Remove a device. Scoped by user id so a session can only ever remove its own
 * devices, never another member's.
 */
export async function deleteSubscription(
  db: PluginDb,
  input: { userId: string; endpoint: string },
): Promise<number> {
  const result = await db.execute(
    `delete from ${db.namespace}.push_subscription where user_id = $1 and endpoint = $2`,
    [input.userId, input.endpoint],
  );
  return result.rowCount;
}

/** Drop a subscription the push service reports as permanently gone. */
export async function deleteByEndpoint(db: PluginDb, endpoint: string): Promise<number> {
  const result = await db.execute(
    `delete from ${db.namespace}.push_subscription where endpoint = $1`,
    [endpoint],
  );
  return result.rowCount;
}

export async function markDelivered(db: PluginDb, subscriptionId: string): Promise<void> {
  await db.execute(
    `update ${db.namespace}.push_subscription
        set last_success_at = now(), failure_count = 0, updated_at = now()
      where id = $1`,
    [subscriptionId],
  );
}

export async function markFailed(db: PluginDb, subscriptionId: string): Promise<void> {
  await db.execute(
    `update ${db.namespace}.push_subscription
        set failure_count = failure_count + 1, updated_at = now()
      where id = $1`,
    [subscriptionId],
  );
}

export type DeliveryRecord = {
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: "delivered" | "failed" | "gone" | "throttled";
  httpStatus?: number | null;
  error?: string | null;
};

/**
 * Record one delivery attempt.
 *
 * This is both the throttle ledger and the audit trail behind "why didn't I get
 * a notification for that?" — the settings page surfaces recent rows per device.
 */
export async function recordDelivery(db: PluginDb, record: DeliveryRecord): Promise<void> {
  await db.execute(
    `insert into ${db.namespace}.push_delivery
       (subscription_id, event_id, event_type, status, http_status, error)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      record.subscriptionId,
      record.eventId,
      record.eventType,
      record.status,
      record.httpStatus ?? null,
      record.error ? record.error.slice(0, 500) : null,
    ],
  );
}

/** How many pushes this device received in the window — the throttle input. */
export async function countRecentDeliveries(
  db: PluginDb,
  subscriptionId: string,
  windowMinutes: number,
): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `select count(*)::text as count from ${db.namespace}.push_delivery
      where subscription_id = $1
        and status = 'delivered'
        and created_at > now() - ($2 || ' minutes')::interval`,
    [subscriptionId, String(windowMinutes)],
  );
  return Number(rows[0]?.count ?? 0);
}

export type RecentDelivery = {
  eventType: string;
  status: string;
  httpStatus: number | null;
  error: string | null;
  createdAt: string;
};

export async function listRecentDeliveries(
  db: PluginDb,
  subscriptionId: string,
  limit = 10,
): Promise<RecentDelivery[]> {
  const rows = await db.query<{
    event_type: string;
    status: string;
    http_status: number | null;
    error: string | null;
    created_at: string;
  }>(
    `select event_type, status, http_status, error, created_at::text as created_at
       from ${db.namespace}.push_delivery
      where subscription_id = $1
      order by created_at desc
      limit $2`,
    [subscriptionId, limit],
  );
  return rows.map((row) => ({
    eventType: row.event_type,
    status: row.status,
    httpStatus: row.http_status,
    error: row.error,
    createdAt: row.created_at,
  }));
}

/** Retention for the delivery ledger; it is diagnostic, not user data. */
export async function pruneDeliveries(db: PluginDb, retentionDays: number): Promise<number> {
  const result = await db.execute(
    `delete from ${db.namespace}.push_delivery
      where created_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
  return result.rowCount;
}

/**
 * Drop devices that keep failing with non-fatal errors (5xx, timeouts) but have
 * never once succeeded — those are stale registrations a push service never
 * reports as gone.
 */
export async function pruneNeverDelivered(
  db: PluginDb,
  minFailures: number,
  olderThanDays: number,
): Promise<number> {
  const result = await db.execute(
    `delete from ${db.namespace}.push_subscription
      where last_success_at is null
        and failure_count >= $1
        and created_at < now() - ($2 || ' days')::interval`,
    [minFailures, String(olderThanDays)],
  );
  return result.rowCount;
}

/** Read the singleton VAPID keypair, if one has been generated. */
export async function getVapidKeypair(
  db: PluginDb,
): Promise<{ publicKey: string; privateKey: string } | null> {
  const rows = await db.query<{ public_key: string; private_key: string }>(
    `select public_key, private_key from ${db.namespace}.vapid_keypair where id = 1`,
  );
  const row = rows[0];
  return row ? { publicKey: row.public_key, privateKey: row.private_key } : null;
}

export async function insertVapidKeypair(
  db: PluginDb,
  keys: { publicKey: string; privateKey: string },
): Promise<void> {
  await db.execute(
    `insert into ${db.namespace}.vapid_keypair (id, public_key, private_key)
     values (1, $1, $2)
     on conflict (id) do nothing`,
    [keys.publicKey, keys.privateKey],
  );
}

/**
 * Generate the instance's VAPID keypair on first use and return it thereafter.
 *
 * `on conflict do nothing` makes this safe when two events race on a cold
 * start: whoever loses the insert simply re-reads the winner's row.
 */
export async function ensureVapidKeypair(
  db: PluginDb,
): Promise<{ publicKey: string; privateKey: string }> {
  const existing = await getVapidKeypair(db);
  if (existing) return existing;

  const generated = webpush.generateVAPIDKeys();
  await insertVapidKeypair(db, generated);
  const stored = await getVapidKeypair(db);
  return stored ?? generated;
}

/**
 * Deliver one encrypted push.
 *
 * Returns the push service's HTTP status on failure so the caller can tell a
 * permanently gone endpoint (404/410 → delete the row) from a transient error
 * (5xx, network → count a failure and retry on the next event).
 */
export async function sendPush(input: {
  subscription: SubscriptionTarget;
  payload: unknown;
  vapid: { publicKey: string; privateKey: string };
  subject: string;
  ttlSeconds?: number;
}): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  try {
    await webpush.sendNotification(
      {
        endpoint: input.subscription.endpoint,
        keys: { p256dh: input.subscription.p256dh, auth: input.subscription.auth },
      },
      JSON.stringify(input.payload),
      {
        vapidDetails: {
          subject: input.subject,
          publicKey: input.vapid.publicKey,
          privateKey: input.vapid.privateKey,
        },
        TTL: input.ttlSeconds ?? 300,
      },
    );
    return { ok: true };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    return {
      ok: false,
      statusCode,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
