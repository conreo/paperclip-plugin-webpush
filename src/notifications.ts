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
  "decision.created": "Decision",
  "decision.expired": "Decision overdue",
  "approval.created": "Approval",
  "issue.assignment_wakeup_requested": "Task assigned",
  "agent.run.failed": "Run failed",
  "budget.incident.opened": "Budget",
  "issue.created": "New task",
};

/**
 * What each trigger is about, in a sentence.
 *
 * The labels above are nouns because they are used as a list you scan — a list of
 * sentences repeated the notification's own wording back at it ("An approval is
 * waiting for a decision" above "Approval needed"). These keep the explanation
 * available, as the list's tooltips and in the editor.
 */
export const EVENT_TYPE_DESCRIPTIONS: Record<NotifiableEventType, string> = {
  "decision.created": "Someone has to make a decision at the decisions desk.",
  "decision.expired": "A decision passed its decide-by date without an answer.",
  "approval.created": "An approval is waiting for a decision.",
  "issue.assignment_wakeup_requested": "A task was handed to someone.",
  "agent.run.failed": "An agent run failed.",
  "budget.incident.opened": "A budget threshold was crossed.",
  "issue.created": "A new task was created.",
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
  organization: string | null = null,
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
  return { title: notificationTitle(eventType, organization, draft.detail), body: "" };
}

/**
 * Turn one domain event into a notification, or `null` when the event carries
 * nothing an operator should be interrupted for.
 *
 * The built-in message is one line, because a push shows one line before it is
 * expanded. Bodies are empty unless an operator writes one. The specifics stay
 * generic where the event does not carry them: the payload is the redacted activity
 * detail, and issue titles or agent prose are not guaranteed to be present (and
 * would blow the payload budget when they are).
 */
/** Operator-supplied text for one trigger. Missing parts keep the built-in wording. */
export type NotificationTemplate = { title?: string; body?: string };

/**
 * How notification text should be rendered for a company.
 *
 * There is no longer a switch for the organization name or the agent name. Both
 * are *objects* an operator places in the text (see `TEMPLATE_OBJECTS`), so a
 * custom message reads exactly as written — and the built-in wording keeps the
 * organization prefix and the agent's name so nothing regresses for an operator
 * who never opens the editor.
 */
export type NotificationPresentation = {
  /** The organization's own name, used to prefix the built-in wording. */
  organizationLabel: string | null;
  templates: Record<string, NotificationTemplate>;
};

/** Per-event facts the wording can use, resolved by the worker. */
export type NotificationEventContext = {
  /** Display name of the agent involved, when the event carries one. */
  agentName?: string | null;
};

/**
 * Every object an operator can place in a message.
 *
 * These are the only names the renderer treats as substitutions, so the editor
 * offers exactly this list as insertable objects and a message can never hold a
 * misspelled one. `org` and `agent` apply to every trigger; the rest come from
 * the event and are listed per trigger in `TEMPLATE_PLACEHOLDERS`.
 */
export const TEMPLATE_OBJECTS = ["org", "agent", "identifier", "title", "type", "scope", "run"] as const;
export type TemplateObject = (typeof TEMPLATE_OBJECTS)[number];

/** What each object puts into a message. Shown in the editor's insert list. */
export const TEMPLATE_OBJECT_HINTS: Record<TemplateObject, string> = {
  org: "The organization: its short name, or the full name when it has none.",
  agent: "The agent the event is about, when it is about one.",
  identifier: "The task's short identifier, such as ACME-42.",
  title: "The task's title.",
  type: "What is being approved, such as “hire agent”.",
  scope: "The budget's scope, such as “monthly”.",
  run: "The short id of the run that failed.",
};

/**
 * The objects each trigger actually has a value for.
 *
 * Every trigger also has `org` and `agent`. An object outside this list renders
 * as nothing, which is why the editor only offers these.
 */
export const TEMPLATE_PLACEHOLDERS: Record<NotifiableEventType, TemplateObject[]> = {
  "decision.created": [],
  "decision.expired": [],
  "approval.created": ["type"],
  "issue.assignment_wakeup_requested": ["identifier"],
  "agent.run.failed": ["run", "identifier"],
  "budget.incident.opened": ["scope"],
  "issue.created": ["identifier", "title"],
};

/** The objects to offer for one trigger, in the order the editor lists them. */
export function templateObjectsFor(eventType: NotifiableEventType): TemplateObject[] {
  const shared: TemplateObject[] = ["org", "agent"];
  return [...shared, ...TEMPLATE_PLACEHOLDERS[eventType]];
}

/** One piece of a message: literal text, or an object that renders to a value. */
export type TemplateSegment =
  | { kind: "text"; value: string }
  | { kind: "object"; name: TemplateObject };

/** `{{name}}` as an operator might type it by hand. */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Whether a name is one of the insertable objects. */
export function isTemplateObject(name: string): name is TemplateObject {
  return (TEMPLATE_OBJECTS as readonly string[]).includes(name);
}

/**
 * Split stored template text into text and object pieces.
 *
 * A name that is not an object stays text, so a hand-written `{{foo}}` survives
 * a round trip through the editor instead of being silently dropped; the
 * preview then shows the literal text an operator would receive.
 */
export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let cursor = 0;

  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "text", value: template.slice(cursor, index) });
    const name = match[1];
    if (isTemplateObject(name)) segments.push({ kind: "object", name });
    else segments.push({ kind: "text", value: match[0] });
    cursor = index + match[0].length;
  }

  if (cursor < template.length) segments.push({ kind: "text", value: template.slice(cursor) });
  return segments;
}

/** The inverse of `parseTemplate`, and the only shape the editor ever saves. */
export function serializeTemplate(segments: readonly TemplateSegment[]): string {
  return segments
    .map((segment) => (segment.kind === "object" ? `{{${segment.name}}}` : segment.value))
    .join("");
}

/**
 * Rewrite hand-typed objects as objects.
 *
 * Applied when a field loses focus, never while typing: converting mid-keystroke
 * would move the caret. After this, `Hello {{org}}` typed by hand is the same
 * message as one composed from the insert list.
 */
export function normalizeTemplate(template: string): string {
  return serializeTemplate(parseTemplate(template));
}

/** True when text holds a `{{name}}` that is not an object (so it renders literally). */
export function hasUnknownPlaceholder(template: string): boolean {
  return parseTemplate(template).some(
    (segment) => segment.kind === "text" && /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(segment.value),
  );
}

/**
 * A short stand-in for an organization's name.
 *
 * Companies normally carry an issue prefix of their own (the `SAK` in `SAK-42`),
 * and that is used when it exists because it is the token its members already
 * read. This is the fallback for one that does not: initials for a multi-word
 * name, otherwise the first letters of the single word. `null` in, `null` out, so
 * an instance with no company name shows no badge rather than an empty one.
 */
export function acronymOf(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  const words = trimmed.split(/[\s_-]+/).filter(Boolean);
  if (words.length > 1) {
    return words
      .slice(0, 3)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }

  const letters = trimmed.replace(/[^\p{L}\p{N}]/gu, "");
  return letters ? letters.slice(0, 3).toUpperCase() : null;
}

/** The agent name the settings page uses to demonstrate objects. */
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

  return { organizationLabel: organizationName, templates };
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

/**
 * Read one event field, wherever the host put it.
 *
 * The activity details arrive **spread flat onto the payload**
 * (`{ ...redactedDetails, agentId, runId, responsibleUserId }` in the host's
 * `persistActivity`), not nested under `details`. Reading `payload.details.type`
 * therefore always missed, and every object that comes from an activity detail —
 * the approval type, the task identifier and title, the budget scope — silently
 * fell back to its generic wording in real notifications while the settings
 * preview (which fills objects with samples) showed a value.
 *
 * The nested form is still checked second: it costs nothing and keeps the wording
 * working if a host ever nests them.
 */
function payloadField(payload: Record<string, unknown>, name: string): unknown {
  if (payload[name] !== undefined) return payload[name];
  return asRecord(payload.details)[name];
}

type Draft = {
  /** The specifics that follow the label and the organization. */
  detail: string;
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
  const agentName = context.agentName?.trim() || null;

  // Each case returns the *specifics* only: the label and the organization are added
  // by `notificationTitle`, which is what makes every built-in notification read
  // "<what happened>: <ORG> | <the specifics>" without each case repeating the
  // scaffolding. The specifics also never restate the label — "Run failed" is
  // followed by who and which run, not by "run failed" again.
  switch (eventType) {
    case "decision.created":
      // The payload carries the origin (issue, agent, responsible user) but no
      // decision title, so the line stays generic and the link goes to the desk
      // where the choice is actually made.
      return {
        detail: agentName ? `${agentName} needs your choice` : "Waiting for your choice",
        url: link(companyPrefix, "/decisions"),
        vars: { agent: agentName },
      };
    case "decision.expired":
      return {
        detail: "Passed its decide-by date",
        url: link(companyPrefix, "/decisions"),
        vars: {},
      };
    case "approval.created": {
      const approvalType = payloadField(payload, "type");
      const readable = typeof approvalType === "string" ? approvalType.replaceAll("_", " ") : "request";

      return {
        // The type is the useful part when nobody is named: a hire request and a
        // spend request want different reactions.
        detail: agentName ? `${agentName} waiting for a decision` : `A ${readable} is waiting`,
        url: link(companyPrefix, `/approvals/${event.entityId ?? ""}`),
        vars: { type: readable, agent: agentName },
      };
    }
    case "issue.assignment_wakeup_requested": {
      const identifierValue = payloadField(payload, "identifier");
      const identifier = typeof identifierValue === "string" ? identifierValue : null;
      return {
        detail: identifier ? `${identifier} waiting on you` : "A task is waiting on you",
        url: link(companyPrefix, `/issues/${event.entityId ?? ""}`),
        vars: { identifier, agent: null },
      };
    }
    case "agent.run.failed": {
      const runRef = shortId(payload.runId);
      const issueId = (payload.issueId as string | undefined) ?? event.entityId ?? "";
      return {
        detail: [agentName, runRef ? `run ${runRef}` : null].filter(Boolean).join(" · ") || "A run failed",
        url: link(companyPrefix, `/issues/${issueId}`),
        vars: { run: runRef, identifier: null, agent: agentName },
      };
    }
    case "budget.incident.opened": {
      const scopeValue = payloadField(payload, "scope");
      const scope = typeof scopeValue === "string" ? scopeValue : "budget";
      const readable = scope.replaceAll("_", " ");
      return {
        detail: readable === "budget" ? "Threshold crossed" : `${readable} threshold crossed`,
        url: link(companyPrefix, "/activity/budgets"),
        vars: { scope: readable, agent: null },
      };
    }
    case "issue.created": {
      const identifierValue = payloadField(payload, "identifier");
      const identifier = typeof identifierValue === "string" ? identifierValue : null;
      const titleValue = payloadField(payload, "title");
      const issueTitle = typeof titleValue === "string" ? titleValue : null;
      return {
        detail: [identifier, issueTitle].filter(Boolean).join(" · ") || "A task was created",
        url: link(companyPrefix, `/issues/${event.entityId ?? ""}`),
        vars: { identifier, title: issueTitle, agent: null },
      };
    }
  }
}

/**
 * The built-in title: what happened, whose organization, and the specifics.
 *
 * One line, because a lock screen shows one line and that is what the notification
 * carries: `Approval: SAK | CodexCoder waiting for a decision`. The organization
 * segment is left out entirely on an instance with no company name, rather than
 * leaving an empty slot with a separator around it.
 */
export function notificationTitle(
  eventType: NotifiableEventType,
  organization: string | null,
  detail: string,
): string {
  const head = organization ? `${EVENT_TYPE_LABELS[eventType]}: ${organization}` : EVENT_TYPE_LABELS[eventType];
  return detail ? `${head} | ${detail}` : head;
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

  const draft = draftFor(event, companyPrefix, eventType, context ?? {});
  const template = presentation?.templates[eventType];
  const vars: Record<string, string | null | undefined> = {
    ...draft.vars,
    agent: context?.agentName ?? draft.vars.agent ?? null,
    org: presentation?.organizationLabel ?? null,
  };

  // A custom title is sent exactly as written — the editor's preview shows what will
  // arrive — and the built-in one gets the organization from its own format rather
  // than from a prefix added afterwards, so there is no rule about when a prefix
  // applies and no way to end up with the name twice.
  const title = template?.title
    ? renderTemplate(template.title, vars)
    : notificationTitle(eventType, presentation?.organizationLabel ?? null, draft.detail);
  const body = template?.body ? renderTemplate(template.body, vars) : "";

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
