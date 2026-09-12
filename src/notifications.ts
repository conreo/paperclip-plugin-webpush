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
 * The built-in wording for a trigger, with no event data.
 *
 * The settings page uses it as placeholder text, so what an operator sees beside
 * an empty field is what they will actually get. Derived from the same source as
 * delivery, so the two cannot drift.
 */
export function previewDefaults(
  eventType: NotifiableEventType,
  context: NotificationEventContext = {},
): { title: string; body: string } {
  const sample = {
    eventId: "preview",
    eventType,
    occurredAt: new Date(0).toISOString(),
    companyId: "preview",
    entityId: "preview",
    entityType: "preview",
    payload: {},
  } as unknown as PluginEvent;
  const draft = draftFor(sample, "COMPANY", eventType, context);
  return { title: draft.title, body: draft.body };
}

/**
 * Turn one domain event into a notification, or `null` when the event carries
 * nothing an operator should be interrupted for.
 *
 * Bodies stay generic on purpose: the event payload is the redacted activity
 * detail, and issue titles or agent prose are not guaranteed to be present (and
 * would blow the payload budget when they are).
 */
/** Operator-supplied text for one trigger. Missing parts keep the built-in wording. */
export type NotificationTemplate = { title?: string; body?: string };

/** How notification text should be rendered for a company. */
export type NotificationPresentation = {
  /** Name to show for the organization; defaults to the company's own name. */
  organizationLabel: string | null;
  includeOrganizationLabel: boolean;
  /** Enrich the built-in wording with the acting agent's name where one applies. */
  includeAgentName: boolean;
  templates: Record<string, NotificationTemplate>;
};

/** Per-event facts the wording can use, resolved by the worker. */
export type NotificationEventContext = {
  /** Display name of the agent involved, when the event carries one. */
  agentName?: string | null;
};

/**
 * Placeholders each trigger offers, for the settings page to document and to
 * preview. Every trigger also has `org`.
 */
export const TEMPLATE_PLACEHOLDERS: Record<NotifiableEventType, string[]> = {
  "decision.created": [],
  "decision.expired": [],
  "approval.created": ["type"],
  "issue.assignment_wakeup_requested": ["identifier"],
  "agent.run.failed": ["run", "identifier"],
  "budget.incident.opened": ["scope"],
  "issue.created": ["identifier", "title"],
};

/** The agent name the settings page uses to demonstrate placeholders. */
export const SAMPLE_AGENT_NAME = "CodexCoder";

/** Sample values so the settings page can render a faithful preview. */
export function sampleTemplateVars(
  eventType: NotifiableEventType,
  organizationLabel: string,
): Record<string, string> {
  const samples: Record<string, string> = {
    agent: SAMPLE_AGENT_NAME,
    type: "hire agent",
    identifier: "ACME-42",
    run: "12345678",
    scope: "monthly",
    title: "Ship the release",
  };
  const vars: Record<string, string> = { org: organizationLabel, agent: samples.agent };
  for (const name of TEMPLATE_PLACEHOLDERS[eventType] ?? []) {
    vars[name] = samples[name] ?? name;
  }
  return vars;
}

export function resolvePresentation(
  raw: unknown,
  organizationName: string | null,
): NotificationPresentation {
  const config = asRecord(raw);
  const templatesRaw = asRecord(config.templates);
  const templates: Record<string, NotificationTemplate> = {};

  for (const [eventType, value] of Object.entries(templatesRaw)) {
    if (!isNotifiableEventType(eventType)) continue;
    const entry = asRecord(value);
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : undefined;
    const body = typeof entry.body === "string" && entry.body.trim() ? entry.body.trim() : undefined;
    if (title || body) templates[eventType] = { title, body };
  }

  const label =
    typeof config.organizationLabel === "string" && config.organizationLabel.trim()
      ? config.organizationLabel.trim()
      : organizationName;

  return {
    organizationLabel: label,
    includeOrganizationLabel:
      typeof config.includeOrganizationLabel === "boolean" ? config.includeOrganizationLabel : true,
    includeAgentName: typeof config.includeAgentName === "boolean" ? config.includeAgentName : true,
    templates,
  };
}

/**
 * Substitute `{{name}}` placeholders.
 *
 * The two "no value" cases are deliberately different:
 * - `undefined` means the name is not a placeholder this trigger knows, so the
 *   text is left verbatim and a typo stays visible in the settings preview.
 * - `null` means the name is valid but this event has no value for it (an
 *   approval without an identifier, say), so it substitutes to nothing instead of
 *   leaving `{{identifier}}` in a notification somebody will read.
 */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    if (typeof value === "string" && value.length > 0) return value;
    return value === null ? "" : match;
  });
}

type Draft = {
  title: string;
  body: string;
  url: string;
  /** `null` marks a valid placeholder this event has no value for. */
  vars: Record<string, string | null>;
};

/** The built-in wording and the values its placeholders can use. */
function draftFor(
  event: PluginEvent,
  companyPrefix: string | null,
  eventType: NotifiableEventType,
  context: NotificationEventContext = {},
): Draft {
  const payload = asRecord(event.payload);
  const details = asRecord(payload.details);
  const agentName = context.agentName?.trim() || null;

  switch (eventType) {
    case "decision.created":
      // The payload carries the origin (issue, agent, responsible user) but no
      // decision title, so the body stays generic and the link goes to the desk
      // where the choice is actually made.
      return {
        title: "Decision needed",
        body: agentName
          ? `${agentName} needs a decision from you.`
          : "A decision is waiting for your choice.",
        url: link(companyPrefix, "/decisions"),
        vars: { agent: agentName },
      };
    case "decision.expired":
      return {
        title: "Decision overdue",
        body: "A decision passed its decide-by date.",
        url: link(companyPrefix, "/decisions"),
        vars: {},
      };
    case "approval.created": {
      const approvalType = typeof details.type === "string" ? details.type : "request";
      const readable = approvalType.replaceAll("_", " ");
      return {
        title: "Approval needed",
        body: agentName
          ? `${agentName} requested a ${readable} and is waiting for a decision.`
          : `A ${readable} is waiting for a decision.`,
        url: link(companyPrefix, `/approvals/${event.entityId ?? ""}`),
        vars: { type: readable, agent: agentName },
      };
    }
    case "issue.assignment_wakeup_requested": {
      const identifier = typeof details.identifier === "string" ? details.identifier : null;
      return {
        title: "Task assigned",
        body: identifier ? `${identifier} is waiting on you.` : "A task is waiting on you.",
        url: link(companyPrefix, `/issues/${event.entityId ?? ""}`),
        vars: { identifier, agent: null },
      };
    }
    case "agent.run.failed": {
      const runRef = shortId(payload.runId);
      const issueId = (payload.issueId as string | undefined) ?? event.entityId ?? "";
      return {
        // The agent's name is the useful part of this notification, so it leads
        // the title whenever the caller resolved one.
        title: agentName ? `${agentName} run failed` : "Agent run failed",
        body: runRef ? `Run ${runRef} failed.` : "An agent run failed.",
        url: link(companyPrefix, `/issues/${issueId}`),
        vars: { run: runRef, identifier: null, agent: agentName },
      };
    }
    case "budget.incident.opened": {
      const scope = typeof details.scope === "string" ? details.scope : "budget";
      const readable = scope.replaceAll("_", " ");
      return {
        title: "Budget threshold crossed",
        body: `A ${readable} incident was opened.`,
        url: link(companyPrefix, "/activity/budgets"),
        vars: { scope: readable, agent: null },
      };
    }
    case "issue.created": {
      const identifier = typeof details.identifier === "string" ? details.identifier : null;
      const issueTitle = typeof details.title === "string" ? details.title : null;
      return {
        title: identifier ? `New task ${identifier}` : "New task",
        body: issueTitle ?? "A task was created.",
        url: link(companyPrefix, `/issues/${event.entityId ?? ""}`),
        vars: { identifier, title: issueTitle, agent: null },
      };
    }
  }
}

/**
 * Turn one domain event into a notification, or `null` when the event carries
 * nothing an operator should be interrupted for.
 *
 * Bodies stay generic by default: the event payload is the redacted activity
 * detail, and issue titles or agent prose are not guaranteed to be present (and
 * would blow the payload budget when they are). Operators can override the
 * wording per trigger, and `presentation` is where that arrives.
 */
export function buildNotification(
  event: PluginEvent,
  companyPrefix: string | null,
  presentation?: NotificationPresentation,
  context?: NotificationEventContext | null,
): NotificationPayload | null {
  // Read the name into a plain string first. Narrowing `event.eventType` directly
  // intersects the host's name with the installed SDK's `PluginEventType` union,
  // which drops any trigger this plugin knows about before the SDK does — the
  // decision lifecycle is in the host (paperclipai/paperclip#13306) but not yet in
  // the published typings.
  const eventType: string = event.eventType;
  if (!isNotifiableEventType(eventType)) return null;

  const draft = draftFor(
    event,
    companyPrefix,
    eventType,
    presentation?.includeAgentName === false ? {} : (context ?? {}),
  );
  const template = presentation?.templates[eventType];
  const vars: Record<string, string | null | undefined> = {
    ...draft.vars,
    // The placeholder is always available, whatever the switch says: the switch
    // only decides whether the *built-in* wording uses the name. A template that
    // asks for {{agent}} gets it either way.
    agent: context?.agentName ?? draft.vars.agent ?? null,
    org: presentation?.organizationLabel ?? null,
  };

  let title = template?.title ? renderTemplate(template.title, vars) : draft.title;
  const body = template?.body ? renderTemplate(template.body, vars) : draft.body;

  // The label is prefixed automatically unless the operator already placed
  // `{{org}}` themselves, so a custom title never ends up with it twice.
  const placesItsOwnLabel = (template?.title ?? "").includes("{{org}}");
  if (presentation?.includeOrganizationLabel && presentation.organizationLabel && !placesItsOwnLabel) {
    title = `${presentation.organizationLabel} · ${title}`;
  }

  return { eventType, eventId: event.eventId, tag: eventType, title, body, url: draft.url };
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

/**
 * Operator configuration, resolved from whatever the host stored.
 *
 * Configuration is company-scoped in Paperclip, so every knob here is one that
 * means something per organization. Instance-wide behaviour (the throttle, the
 * prune window, the VAPID subject fallback) is deliberately not configurable:
 * a per-company value for those would be a lie, because the throttle counts a
 * device across companies and the prune job has no company context at all.
 *
 * Everything is optional. An empty config, a partial config, or a config holding
 * nonsense must all resolve to working defaults rather than failing at delivery
 * time.
 */
export type ResolvedPluginConfig = {
  /** Triggers a newly enabled browser starts with. */
  defaultTriggers: NotifiableEventType[];
  /** Whether events that name nobody responsible notify the company's members. */
  notifyUnassignedEvents: boolean;
};

export function resolvePluginConfig(raw: unknown): ResolvedPluginConfig {
  const config = asRecord(raw);

  const requested = config.defaultTriggers;
  const defaultTriggers = Array.isArray(requested)
    ? requested.filter(
        (entry): entry is NotifiableEventType =>
          typeof entry === "string" && isNotifiableEventType(entry),
      )
    : [...DEFAULT_EVENT_TYPES];

  return {
    // An explicitly empty list is a real choice ("start muted, opt in per
    // trigger"); only a missing or unusable value falls back to the defaults.
    defaultTriggers: Array.isArray(requested) ? defaultTriggers : [...DEFAULT_EVENT_TYPES],
    notifyUnassignedEvents:
      typeof config.notifyUnassignedEvents === "boolean" ? config.notifyUnassignedEvents : true,
  };
}

/**
 * The agent an event is about, from the three places the host puts one.
 *
 * `payload.agentId` is the activity actor's agent, `details.originAgentId` is the
 * agent a decision came from, and `actorId` carries the agent when an agent acted
 * directly. Agent ids are UUIDs; anything else is ignored rather than looked up.
 */
export function agentIdOf(event: PluginEvent): string | null {
  const payload = asRecord(event.payload);
  const details = asRecord(payload.details);
  const candidates = [
    payload.agentId,
    details.originAgentId,
    event.actorType === "agent" ? event.actorId : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

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
