import type { PluginEvent } from "@paperclipai/plugin-sdk";

/**
 * Notification payload as it crosses the wire to the service worker and is
 * rendered by `showNotification`.
 *
 * Kept deliberately small: push payloads are encrypted with aes128gcm and each
 * push service caps them at 4 KB, so the payload is a title, a one-line body, a
 * deep link, and a collapse tag — never entity bodies.
 */
export type NotificationPayload = {
  eventType: string;
  eventId: string;
  title: string;
  body: string;
  url: string;
  tag: string;
};

/**
 * Events this plugin turns into notifications.
 *
 * Every entry is a `PluginEventType` the host actually emits: activity-log
 * actions pass through to plugins either by exact name (`approval.created` is
 * logged verbatim by the approvals route) or via the host's action→event map.
 * `issue.created` is included because it is the cheapest way an operator can
 * prove delivery end to end; the rest are the attention-worthy board events.
 */
export const NOTIFIABLE_EVENT_TYPES = [
  "approval.created",
  "issue.assignment_wakeup_requested",
  "agent.run.failed",
  "budget.incident.opened",
  "issue.created",
  // Decisions Desk lifecycle. `decision.created` is the platform's "a human must
  // choose, by this date" object; `decision.expired` means that deadline already
  // passed. The `dismissed` and `cancelled` outcomes are deliberately absent:
  // they report that a decision is settled, which is not a reason to interrupt
  // anybody. These names arrive only from a host that emits them (the plugin
  // event surface gained them in paperclipai/paperclip#13306); on an older host
  // the subscription simply never matches, which is why it is safe to register
  // unconditionally.
  "decision.created",
  "decision.expired",
] as const;

export type NotifiableEventType = (typeof NOTIFIABLE_EVENT_TYPES)[number];

/**
 * Defaults are attention-shaped on purpose: a push should mean "a human is
 * needed", which in Paperclip means a decision or an inbox-addressed item.
 * `approval.created` is both (approvals are decisions and they land in the
 * inbox), and an assignment wakeup is addressed to a person. Agent activity
 * (`agent.run.failed`) and new tasks are deliberately opt-in: pushing them by
 * default is how a notification channel gets muted.
 */
export const DEFAULT_EVENT_TYPES: NotifiableEventType[] = [
  "decision.created",
  "approval.created",
  "issue.assignment_wakeup_requested",
  "budget.incident.opened",
];

export function isNotifiableEventType(value: string): value is NotifiableEventType {
  return (NOTIFIABLE_EVENT_TYPES as readonly string[]).includes(value);
}

/** Short human label per event type, used by the settings UI. */
export const EVENT_TYPE_LABELS: Record<NotifiableEventType, string> = {
  "decision.created": "The decisions desk needs a choice from you",
  "decision.expired": "A decision passed its decide-by date",
  "approval.created": "An approval is waiting for a decision",
  "issue.assignment_wakeup_requested": "A task was handed to someone",
  "agent.run.failed": "An agent run failed",
  "budget.incident.opened": "A budget threshold was crossed",
  "issue.created": "A new task was created",
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function shortId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 8) : null;
}

/**
 * Deep links use the company's route prefix (`/<issuePrefix>/issues/<id>`),
 * which is the same prefix the app puts in the URL bar. Without it the app
 * would render its "Company not found" page.
 */
function link(companyPrefix: string | null, path: string): string {
  return companyPrefix ? `/${companyPrefix}${path}` : path;
}

/**
 * Turn one domain event into a notification, or `null` when the event carries
 * nothing an operator should be interrupted for.
 *
 * Bodies stay generic on purpose: the event payload is the redacted activity
 * detail, and issue titles or agent prose are not guaranteed to be present (and
 * would blow the payload budget when they are).
 */
export function buildNotification(
  event: PluginEvent,
  companyPrefix: string | null,
): NotificationPayload | null {
  // Read the name into a plain string first. Narrowing `event.eventType` directly
  // intersects the host's name with the installed SDK's `PluginEventType` union,
  // which drops any trigger this plugin knows about before the SDK does — the
  // decision lifecycle is in the host (paperclipai/paperclip#13306) but not yet in
  // the published typings.
  const eventType: string = event.eventType;
  if (!isNotifiableEventType(eventType)) return null;

  const payload = asRecord(event.payload);
  const details = asRecord(payload.details);
  const eventId = event.eventId;
  const base = { eventType, eventId, tag: eventType };

  switch (eventType) {
    case "decision.created": {
      // The payload carries the origin (issue, agent, responsible user) but no
      // decision title, so the body stays generic and the link goes to the desk
      // where the choice is actually made.
      return {
        ...base,
        title: "Decision needed",
        body: "A decision is waiting for your choice.",
        url: link(companyPrefix, "/decisions"),
      };
    }
    case "decision.expired": {
      return {
        ...base,
        title: "Decision overdue",
        body: "A decision passed its decide-by date.",
        url: link(companyPrefix, "/decisions"),
      };
    }
    case "approval.created": {
      const approvalType = typeof details.type === "string" ? details.type : "request";
      return {
        ...base,
        title: "Approval needed",
        body: `A ${approvalType.replaceAll("_", " ")} is waiting for a decision.`,
        url: link(companyPrefix, `/approvals/${event.entityId ?? ""}`),
      };
    }
    case "issue.assignment_wakeup_requested": {
      const identifier = typeof details.identifier === "string" ? details.identifier : null;
      return {
        ...base,
        title: "Task assigned",
        body: identifier ? `${identifier} is waiting on you.` : "A task is waiting on you.",
        url: link(companyPrefix, `/issues/${event.entityId ?? ""}`),
      };
    }
    case "agent.run.failed": {
      const runRef = shortId(payload.runId);
      return {
        ...base,
        title: "Agent run failed",
        body: runRef ? `Run ${runRef} failed.` : "An agent run failed.",
        url: link(companyPrefix, `/issues/${(payload.issueId as string | undefined) ?? event.entityId ?? ""}`),
      };
    }
    case "budget.incident.opened": {
      const scope = typeof details.scope === "string" ? details.scope : "budget";
      return {
        ...base,
        title: "Budget threshold crossed",
        body: `A ${scope.replaceAll("_", " ")} incident was opened.`,
        url: link(companyPrefix, "/activity/budgets"),
      };
    }
    case "issue.created": {
      const identifier = typeof details.identifier === "string" ? details.identifier : null;
      const title = typeof details.title === "string" ? details.title : null;
      return {
        ...base,
        title: identifier ? `New task ${identifier}` : "New task",
        body: title ?? "A task was created.",
        url: link(companyPrefix, `/issues/${event.entityId ?? ""}`),
      };
    }
    default:
      return null;
  }
}

/** A subscription row as the fan-out sees it. */
export type SubscriptionTarget = {
  id: string;
  userId: string;
  companyId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  eventTypes: string[];
  enabled: boolean;
  origin: string | null;
};

/** The user the activity log holds responsible for an event, if it named one. */
export function responsibleUserIdOf(event: PluginEvent): string | null {
  const value = asRecord(event.payload).responsibleUserId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The user ids of active human members.
 *
 * Agent principals are excluded: a notification is for a person, and an agent
 * member holds no browser. Suspended and pending members are excluded for the
 * same reason — they cannot act on what they are told.
 */
export function activeUserMemberIds(
  members: readonly { principalType: string; principalId: string; status: string }[],
): string[] {
  const ids = new Set<string>();
  for (const member of members) {
    if (member.principalType !== "user") continue;
    if (member.status !== "active") continue;
    if (!member.principalId) continue;
    ids.add(member.principalId);
  }
  return [...ids];
}

function wantsEventType(subscription: SubscriptionTarget, eventType: string): boolean {
  return subscription.eventTypes.length === 0 || subscription.eventTypes.includes(eventType);
}

/**
 * Decide which subscriptions receive one event.
 *
 * Two candidate sets feed this, and the difference is the whole point:
 *
 *  - `responsibleSubscriptions` are the device rows of the user the activity log
 *    named as responsible, fetched **regardless of company**. A person who is
 *    responsible for an approval in company B must hear about it on the device
 *    they registered while looking at company A; scoping delivery to the company
 *    a device was registered under silently drops every other company's events,
 *    which on a multi-company instance reads as "notifications are broken".
 *  - `broadcastSubscriptions` are the devices of the event company's active
 *    members. They are the fallback for events that name nobody responsible, and
 *    they deliberately stay company-scoped: an unassigned budget incident in one
 *    company must not buzz every other company's subscribers. The caller resolves
 *    membership, so this stays a pure function.
 */
export function planDelivery(input: {
  /** Devices of the user the event names responsible, in any company. */
  responsibleSubscriptions?: SubscriptionTarget[];
  /**
   * Devices to use when the event names nobody responsible. The caller decides
   * the scope and supplies exactly the eligible devices, so this module does not
   * have to know how membership is resolved.
   */
  broadcastSubscriptions?: SubscriptionTarget[];
  event: PluginEvent;
  broadcastWhenUnassigned?: boolean;
}): SubscriptionTarget[] {
  const { event } = input;
  const responsibleUserId = responsibleUserIdOf(event);

  const candidates = responsibleUserId
    ? (input.responsibleSubscriptions ?? []).filter(
        (subscription) => subscription.userId === responsibleUserId,
      )
    : (input.broadcastWhenUnassigned ?? true)
      ? (input.broadcastSubscriptions ?? [])
      : [];

  const seen = new Set<string>();
  const recipients: SubscriptionTarget[] = [];
  for (const subscription of candidates) {
    if (!subscription.enabled) continue;
    if (!wantsEventType(subscription, event.eventType)) continue;
    if (seen.has(subscription.id)) continue;
    seen.add(subscription.id);
    recipients.push(subscription);
  }
  return recipients;
}

/**
 * Per-subscription flood control.
 *
 * A single runaway agent can emit hundreds of events a minute; without this the
 * operator's desktop turns into a wall of toasts and they revoke permission.
 * Throttled deliveries are still recorded, so the settings page can explain why
 * a notification never arrived.
 */
export function shouldThrottle(
  recentDeliveries: number,
  limits: { max: number },
): boolean {
  return recentDeliveries >= limits.max;
}

/** The VAPID `sub` claim must be a mailto: or https: URL. */
export function resolveVapidSubject(origin: string | null, fallback: string): string {
  if (origin && origin.startsWith("https://")) return origin;
  return fallback;
}
