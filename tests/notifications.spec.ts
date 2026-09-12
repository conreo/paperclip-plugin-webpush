import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_EVENT_TYPES,
  EVENT_TYPE_DESCRIPTIONS,
  EVENT_TYPE_LABELS,
  TEMPLATE_OBJECTS,
  TEMPLATE_OBJECT_HINTS,
  acronymOf,
  activeUserMemberIds,
  NOTIFIABLE_EVENT_TYPES,
  buildNotification,
  hasUnknownPlaceholder,
  normalizeTemplate,
  notificationTitle,
  parseTemplate,
  previewDefaults,
  renderTemplate,
  resolvePluginConfig,
  resolvePresentation,
  resolveVapidSubject,
  planDelivery,
  serializeTemplate,
  shouldThrottle,
  templateObjectsFor,
  type SubscriptionTarget,
} from "../src/notifications.js";

/**
 * Builds an event envelope. Deliberately loosely typed: these tests exercise
 * trigger names that exist in the host before the published SDK typings include
 * them (the decision lifecycle), and the runtime value is a plain string.
 */
function event(overrides: Record<string, unknown> = {}): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "approval.created",
    occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    companyId: "company-1",
    entityId: "entity-1",
    entityType: "approval",
    actorId: "user-1",
    actorType: "user",
    payload: {},
    ...overrides,
  } as unknown as PluginEvent;
}

function subscription(overrides: Partial<SubscriptionTarget> = {}): SubscriptionTarget {
  return {
    id: "sub-1",
    userId: "user-1",
    companyId: "company-1",
    endpoint: "https://push.example/1",
    p256dh: "p",
    auth: "a",
    eventTypes: [],
    enabled: true,
    origin: "https://paperclip.example",
    ...overrides,
  };
}

describe("notification defaults", () => {
  it("keeps agent activity out of the defaults", () => {
    // A push should mean a human is needed. Agent activity stays available, but
    // opting people into it by default is how a channel gets muted.
    expect(DEFAULT_EVENT_TYPES).not.toContain("agent.run.failed");
    expect(DEFAULT_EVENT_TYPES).not.toContain("issue.created");
    expect(NOTIFIABLE_EVENT_TYPES).toContain("agent.run.failed");
  });

  it("defaults to the signals that mean a person must act", () => {
    expect(DEFAULT_EVENT_TYPES).toEqual([
      "decision.created",
      "approval.created",
      "issue.assignment_wakeup_requested",
      "budget.incident.opened",
    ]);
  });
});

describe("decision notifications", () => {
  it("deep-links a new decision to the decisions desk", () => {
    const notification = buildNotification(
      event({
        eventType: "decision.created",
        entityId: "decision-1",
        entityType: "decision",
        payload: { details: { originIssueId: "issue-9", originResponsibleUserId: "user-1" } },
      }),
      "ACME",
    );
    expect(notification).toMatchObject({
      title: "Decision | Waiting for your choice",
      url: "/ACME/decisions",
      tag: "decision.created",
      eventId: "evt-1",
    });
  });

  it("flags a decision that passed its decide-by date", () => {
    const notification = buildNotification(
      event({ eventType: "decision.expired", entityId: "decision-2", entityType: "decision" }),
      "ACME",
    );
    expect(notification?.title).toBe("Decision overdue | Passed its decide-by date");
    expect(notification?.url).toBe("/ACME/decisions");
  });

  it("does not offer the settled outcomes as triggers", () => {
    // dismissed/cancelled report that a decision is done; interrupting someone
    // for that is noise.
    expect(NOTIFIABLE_EVENT_TYPES).not.toContain("decision.dismissed");
    expect(NOTIFIABLE_EVENT_TYPES).not.toContain("decision.cancelled");
  });
});

describe("buildNotification", () => {
  it("deep-links approvals under the company route prefix", () => {
    const notification = buildNotification(event({ entityId: "appr-9" }), "ACME");
    expect(notification).toMatchObject({
      title: "Approval | A request is waiting",
      url: "/ACME/approvals/appr-9",
      tag: "approval.created",
      eventId: "evt-1",
    });
  });

  it("falls back to an unprefixed link when the prefix is unknown", () => {
    const notification = buildNotification(event({ entityId: "appr-9" }), null);
    expect(notification?.url).toBe("/approvals/appr-9");
  });

  it("carries the run id and the issue link on a failed run", () => {
    const notification = buildNotification(
      event({
        eventType: "agent.run.failed",
        entityId: "run-1",
        entityType: "run",
        payload: { runId: "1234567890ab", issueId: "issue-7" },
      }),
      "ACME",
    );
    expect(notification?.url).toBe("/ACME/issues/issue-7");
    expect(notification?.title).toContain("12345678");
  });

  it("includes the issue title for a created task", () => {
    const notification = buildNotification(
      event({
        eventType: "issue.created",
        entityId: "issue-3",
        payload: { details: { identifier: "ACME-42", title: "Ship the thing" } },
      }),
      "ACME",
    );
    expect(notification?.title).toBe("New task | ACME-42 · Ship the thing");
    expect(notification?.body).toBe("");
  });

  it("ignores event types it does not notify on", () => {
    expect(buildNotification(event({ eventType: "issue.updated" }), "ACME")).toBeNull();
  });
});

describe("planDelivery", () => {
  it("targets the responsible user's devices even when they were registered in another company", () => {
    // The device was registered while looking at company-2, but the user is the
    // responsible party for an approval in company-1. Company-scoping delivery
    // would drop this silently.
    const registeredElsewhere = subscription({
      id: "elsewhere",
      userId: "user-1",
      companyId: "company-2",
    });
    const recipients = planDelivery({
      responsibleSubscriptions: [registeredElsewhere],
      event: event({ companyId: "company-1", payload: { responsibleUserId: "user-1" } }),
    });
    expect(recipients.map((entry) => entry.id)).toEqual(["elsewhere"]);
  });

  it("notifies only the named responsible user, not their colleagues", () => {
    const recipients = planDelivery({
      broadcastSubscriptions: [subscription({ id: "theirs", userId: "user-2" })],
      responsibleSubscriptions: [
        subscription({ id: "mine", userId: "user-1" }),
        subscription({ id: "theirs", userId: "user-2" }),
      ],
      event: event({ payload: { responsibleUserId: "user-1" } }),
    });
    expect(recipients.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("uses exactly the broadcast devices the caller supplies", () => {
    // Scope is the caller's decision: the worker narrows to the event company's
    // members, so this function must not widen it again.
    const recipients = planDelivery({
      broadcastSubscriptions: [subscription({ id: "member", companyId: "company-2" })],
      event: event({ eventType: "budget.incident.opened", payload: {} }),
    });
    expect(recipients.map((entry) => entry.id)).toEqual(["member"]);
  });

  it("stays silent when unassigned and broadcasting is disabled", () => {
    const recipients = planDelivery({
      broadcastSubscriptions: [subscription()],
      event: event({ payload: {} }),
      broadcastWhenUnassigned: false,
    });
    expect(recipients).toEqual([]);
  });

  it("honours the enabled flag and per-device event choices", () => {
    const recipients = planDelivery({
      responsibleSubscriptions: [
        subscription({ id: "disabled", userId: "user-1", enabled: false }),
        subscription({ id: "opted-out", userId: "user-1", eventTypes: ["budget.incident.opened"] }),
        subscription({ id: "opted-in", userId: "user-1", eventTypes: ["approval.created"] }),
      ],
      event: event({ payload: { responsibleUserId: "user-1" } }),
    });
    expect(recipients.map((entry) => entry.id)).toEqual(["opted-in"]);
  });

  it("treats an empty event list as 'everything'", () => {
    const recipients = planDelivery({
      responsibleSubscriptions: [subscription({ userId: "user-1", eventTypes: [] })],
      event: event({ payload: { responsibleUserId: "user-1" } }),
    });
    expect(recipients).toHaveLength(1);
  });
});

describe("resolvePluginConfig", () => {
  it("falls back to the shipped defaults for missing or unusable input", () => {
    for (const raw of [undefined, null, {}, "nonsense", 42, { defaultTriggers: "decision.created" }]) {
      const config = resolvePluginConfig(raw);
      expect(config.defaultTriggers).toEqual(DEFAULT_EVENT_TYPES);
      expect(config.notifyUnassignedEvents).toBe(true);
    }
  });

  it("honours a saved configuration", () => {
    const config = resolvePluginConfig({
      defaultTriggers: ["decision.created", "approval.created"],
      notifyUnassignedEvents: false,
    });
    expect(config.defaultTriggers).toEqual(["decision.created", "approval.created"]);
    expect(config.notifyUnassignedEvents).toBe(false);
  });

  it("treats an explicitly empty trigger list as a real choice", () => {
    // "Start muted, opt in per trigger" is a legitimate configuration. Only a
    // missing or unusable value may fall back to the defaults.
    expect(resolvePluginConfig({ defaultTriggers: [] }).defaultTriggers).toEqual([]);
  });

  it("drops trigger names it cannot deliver on", () => {
    const config = resolvePluginConfig({
      defaultTriggers: ["decision.created", "not.a.real.event", "issue.created", 7],
    });
    expect(config.defaultTriggers).toEqual(["decision.created", "issue.created"]);
  });

  it("keeps a partial configuration usable", () => {
    expect(resolvePluginConfig({ defaultTriggers: ["decision.created"] }).notifyUnassignedEvents).toBe(
      true,
    );
    expect(resolvePluginConfig({ notifyUnassignedEvents: false }).defaultTriggers).toEqual(
      DEFAULT_EVENT_TYPES,
    );
    // A non-boolean is not a choice, so the safe default stands.
    expect(resolvePluginConfig({ notifyUnassignedEvents: "false" }).notifyUnassignedEvents).toBe(true);
  });
});

describe("activeUserMemberIds", () => {
  it("keeps active humans and drops agents, pendings, and suspensions", () => {
    // A notification is for a person. An agent member holds no browser, and a
    // pending or suspended member cannot act on what they are told.
    expect(
      activeUserMemberIds([
        { principalType: "user", principalId: "user-1", status: "active" },
        { principalType: "agent", principalId: "agent-1", status: "active" },
        { principalType: "user", principalId: "user-2", status: "pending" },
        { principalType: "user", principalId: "user-3", status: "suspended" },
        { principalType: "user", principalId: "user-4", status: "active" },
      ]),
    ).toEqual(["user-1", "user-4"]);
  });

  it("deduplicates and tolerates an empty roster", () => {
    expect(
      activeUserMemberIds([
        { principalType: "user", principalId: "user-1", status: "active" },
        { principalType: "user", principalId: "user-1", status: "active" },
      ]),
    ).toEqual(["user-1"]);
    expect(activeUserMemberIds([])).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes values and tolerates spacing", () => {
    expect(renderTemplate("{{org}} · {{ identifier }}", { org: "Acme", identifier: "ACME-42" })).toBe(
      "Acme · ACME-42",
    );
  });

  it("empties a valid placeholder that this event has no value for", () => {
    // `null` means "known name, no value here" — the operator must not read
    // `{{identifier}}` in an actual notification.
    expect(renderTemplate("{{identifier}} is waiting", { identifier: null })).toBe(" is waiting");
  });

  it("keeps an unknown placeholder verbatim so a typo is visible", () => {
    expect(renderTemplate("{{org}} {{oops}}", { org: "Acme" })).toBe("Acme {{oops}}");
  });

  it("treats an empty string as no value for a known name", () => {
    expect(renderTemplate("[{{org}}]", { org: "" })).toBe("[{{org}}]");
  });
});

describe("resolvePresentation", () => {
  it("defaults to the organization's own name", () => {
    const presentation = resolvePresentation(null, "Acme");
    expect(presentation).toMatchObject({ organizationLabel: "Acme" });
    expect(presentation.templates).toEqual({});
  });

  it("uses the organization's own name, ignoring a leftover override", () => {
    // The override field is gone: an organization is named by its own name, and a
    // config written by an older version must not keep renaming it.
    const presentation = resolvePresentation({ organizationLabel: "  Acme Ops  " }, "Acme");
    expect(presentation.organizationLabel).toBe("Acme");
  });

  it("keeps only usable templates for triggers it can deliver", () => {
    const presentation = resolvePresentation(
      {
        templates: {
          "approval.created": { title: "Sign this", body: "  " },
          "issue.created": { body: "{{identifier}}: {{title}}" },
          "not.a.trigger": { title: "ignored" },
          "agent.run.failed": {},
        },
      },
      "Acme",
    );
    expect(presentation.templates).toEqual({
      "approval.created": { title: "Sign this", body: undefined },
      "issue.created": { title: undefined, body: "{{identifier}}: {{title}}" },
    });
  });

  it("resolves without a company name at all", () => {
    expect(resolvePresentation({}, null).organizationLabel).toBeNull();
  });
});

describe("buildNotification with configured text", () => {
  const presentation = (overrides: Partial<Parameters<typeof buildNotification>[2]> = {}) => ({
    organizationLabel: "Acme",
    templates: {},
    ...overrides,
  });

  it("prefixes the organization name", () => {
    const notification = buildNotification(event(), "ACME", presentation());
    expect(notification?.title).toBe("Approval: Acme | A request is waiting");
  });

  it("uses an operator title and body, with placeholders filled", () => {
    const notification = buildNotification(
      event({ payload: { details: { identifier: "ACME-7", title: "Ship it" } } , eventType: "issue.created" }),
      "ACME",
      presentation({ templates: { "issue.created": { title: "{{org}}: new task", body: "{{identifier}} {{title}}" } } }),
    );
    // `{{org}}` is substituted, and the automatic label prefix is skipped because
    // the operator placed the label themselves.
    expect(notification?.title).toBe("Acme: new task");
    expect(notification?.body).toBe("ACME-7 Ship it");
  });

  it("does not prefix the label twice when the title already places it", () => {
    const notification = buildNotification(
      event(),
      "ACME",
      presentation({ templates: { "approval.created": { title: "{{org}} needs you" } } }),
    );
    expect(notification?.title).toBe("Acme needs you");
  });

  it("falls back to the built-in wording when a template is absent", () => {
    const notification = buildNotification(event(), "ACME", presentation({ templates: {} }));
    expect(notification?.title).toBe("Approval: Acme | A request is waiting");
    expect(notification?.body).toBe("");
  });

  it("leaves a custom title exactly as written, without the organization prefix", () => {
    // The editor's preview is the promise: what it shows is what arrives, so a
    // custom title is never silently prefixed. An operator who wants the name
    // inserts {{org}}.
    const notification = buildNotification(
      event(),
      "ACME",
      presentation({ templates: { "approval.created": { title: "Sign this" } } }),
    );
    expect(notification?.title).toBe("Sign this");

    const withObject = buildNotification(
      event(),
      "ACME",
      presentation({ templates: { "approval.created": { title: "{{org}}: sign this" } } }),
    );
    expect(withObject?.title).toBe("Acme: sign this");
  });

  it("keeps the objects in the order the operator placed them", () => {
    const notification = buildNotification(
      event(),
      "ACME",
      presentation({
        templates: { "approval.created": { title: "{{type}} at {{org}}", body: "{{agent}} → {{org}}" } },
      }),
      { agentName: "CodexCoder" },
    );
    expect(notification?.title).toBe("request at Acme");
    expect(notification?.body).toBe("CodexCoder → Acme");
  });

  it("names the agent in the wording it is about", () => {
    const failed = buildNotification(
      event({ eventType: "agent.run.failed", entityId: "run-1", payload: { runId: "1234567890ab" } }),
      "ACME",
      presentation(),
      { agentName: "CodexCoder" },
    );
    expect(failed?.title).toBe("Run failed: Acme | CodexCoder · run 12345678");

    expect(buildNotification(event(), "ACME", presentation(), { agentName: "CodexCoder" })?.title).toBe(
      "Approval: Acme | CodexCoder waiting for a decision",
    );
  });

  it("resolves {{agent}} in a template", () => {
    const notification = buildNotification(
      event(),
      "ACME",
      presentation({ templates: { "approval.created": { body: "{{agent}} needs you" } } }),
      { agentName: "CodexCoder" },
    );
    expect(notification?.body).toBe("CodexCoder needs you");
  });

  it("empties {{agent}} for an event that involves no agent", () => {
    const notification = buildNotification(
      event({ eventType: "budget.incident.opened", payload: {} }),
      "ACME",
      presentation({ templates: { "budget.incident.opened": { body: "scope={{scope}} agent={{agent}}" } } }),
    );
    expect(notification?.body).toBe("scope=budget agent=");
  });

  it("previews the built-in wording for the settings page", () => {
    expect(previewDefaults("approval.created", {}, "Acme")).toEqual({
      title: "Approval: Acme | A request is waiting",
      body: "",
    });
  });
});

describe("where event fields are read from", () => {
  // The host spreads an activity's details flat onto the plugin event payload
  // (`{ ...redactedDetails, agentId, runId, responsibleUserId }`), so reading
  // `payload.details.*` silently missed every field taken from a detail. The
  // built-in wording fell back to its generic text in real notifications while the
  // settings preview showed sample values.
  it("resolves the fields spread flat onto the payload", () => {
    const created = buildNotification(
      event({
        eventType: "issue.created",
        payload: { identifier: "ACME-42", title: "Ship the release", agentId: null, runId: null },
      }),
      "ACME",
    );
    expect(created?.title).toBe("New task | ACME-42 · Ship the release");
  });

  it("resolves the approval type from the flat payload", () => {
    const approval = buildNotification(
      event({ eventType: "approval.created", payload: { type: "hire_agent", issueIds: [] } }),
      "ACME",
    );
    expect(approval?.title).toBe("Approval | A hire agent is waiting");
    expect(approval?.body).toBe("");
  });

  it("resolves a template object that only exists in the flat payload", () => {
    const notification = buildNotification(
      event({ eventType: "issue.created", payload: { identifier: "ACME-42", title: "Ship the release" } }),
      "ACME",
      { organizationLabel: "Acme", templates: { "issue.created": { title: "{{identifier}}: {{title}}" } } },
    );
    expect(notification?.title).toBe("ACME-42: Ship the release");
  });

  it("still reads a nested details object, for a host that nests them", () => {
    const nested = buildNotification(
      event({ eventType: "issue.created", payload: { details: { identifier: "ACME-7", title: "Nested" } } }),
      "ACME",
    );
    expect(nested?.title).toBe("New task | ACME-7 · Nested");
    expect(nested?.body).toBe("");
  });

  it("falls back to the generic wording when the event carries nothing", () => {
    const bare = buildNotification(event({ eventType: "issue.created", payload: {} }), "ACME");
    expect(bare?.title).toBe("New task | A task was created");
    expect(bare?.body).toBe("");
  });
});

describe("how a trigger is labelled", () => {
  it("labels every trigger with a noun, not a sentence", () => {
    // The labels are a list you scan. A sentence per row repeated the
    // notification's own wording back at it, which is what made the section read
    // as the same fact three times.
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      const label = EVENT_TYPE_LABELS[type];
      expect(label.length).toBeLessThanOrEqual(16);
      expect(label.endsWith(".")).toBe(false);
      expect(label.split(" ").length).toBeLessThanOrEqual(2);
    }
  });

  it("keeps the explanation of each trigger available", () => {
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      expect(EVENT_TYPE_DESCRIPTIONS[type]?.length ?? 0).toBeGreaterThan(10);
    }
  });
});

describe("acronymOf", () => {
  it("takes the initials of a multi-word name", () => {
    expect(acronymOf("Acme Trading Company")).toBe("STC");
    expect(acronymOf("acme ops")).toBe("DT");
  });

  it("takes the first letters of a single word", () => {
    expect(acronymOf("Northwind")).toBe("DEL");
    expect(acronymOf("Acme")).toBe("SPO");
  });

  it("strips punctuation and collapses separators", () => {
    expect(acronymOf("northwind-ops")).toBe("DO");
    expect(acronymOf("  Acme, Inc.  ")).toBe("AI");
  });

  it("answers nothing for a company with no name, rather than an empty badge", () => {
    expect(acronymOf(null)).toBeNull();
    expect(acronymOf(undefined)).toBeNull();
    expect(acronymOf("   ")).toBeNull();
    expect(acronymOf("...")).toBeNull();
  });
});

describe("the built-in notification line", () => {
  it("reads <what happened>: <ORG> | <the specifics>", () => {
    expect(notificationTitle("approval.created", "SAK", "CodexCoder waiting for a decision")).toBe(
      "Approval: SAK | CodexCoder waiting for a decision",
    );
  });

  it("leaves out the organization segment when there is none", () => {
    expect(notificationTitle("approval.created", null, "CodexCoder waiting for a decision")).toBe(
      "Approval | CodexCoder waiting for a decision",
    );
    expect(notificationTitle("issue.created", "", "A task was created")).toBe(
      "New task | A task was created",
    );
  });

  it("is one line: every built-in body is empty", () => {
    // The line carries everything, so a body only exists when an operator writes
    // one. A non-empty built-in body would be a second line nobody asked for.
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      expect(previewDefaults(type, {}, "SAK").body).toBe("");
      expect(notificationTitle(type, "SAK", "").startsWith(EVENT_TYPE_LABELS[type])).toBe(true);
    }
  });

  it("says the specifics without restating the label", () => {
    // "Run failed: SAK | CodexCoder · run 1234" rather than "... run failed".
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      const draft = previewDefaults(type, { agentName: "CodexCoder" }, "SAK");
      const labelIndex = draft.title.indexOf(EVENT_TYPE_LABELS[type]);
      expect(labelIndex).toBe(0);
      expect(draft.title.slice(EVENT_TYPE_LABELS[type].length)).not.toContain(EVENT_TYPE_LABELS[type]);
    }
  });
});

describe("template objects", () => {
  it("round-trips text and objects through parse and serialize", () => {
    const template = "{{org}} · {{title}} needs you";
    const segments = parseTemplate(template);
    expect(segments).toEqual([
      { kind: "object", name: "org" },
      { kind: "text", value: " · " },
      { kind: "object", name: "title" },
      { kind: "text", value: " needs you" },
    ]);
    expect(serializeTemplate(segments)).toBe(template);
  });

  it("keeps a hand-written name that is not an object as literal text", () => {
    // Silently dropping it would lose what the operator wrote, and it is exactly
    // what the preview shows arriving.
    const segments = parseTemplate("{{oops}} is literal");
    expect(segments).toEqual([
      { kind: "text", value: "{{oops}}" },
      { kind: "text", value: " is literal" },
    ]);
    expect(serializeTemplate(segments)).toBe("{{oops}} is literal");
  });

  it("normalises hand-typed objects, spacing included, without touching the rest", () => {
    expect(normalizeTemplate("hey {{ org }} and {{oops}}")).toBe("hey {{org}} and {{oops}}");
  });

  it("reports which text holds something that is not an object", () => {
    expect(hasUnknownPlaceholder("a {{oops}} b")).toBe(true);
    expect(hasUnknownPlaceholder("a {{org}} b")).toBe(false);
    expect(hasUnknownPlaceholder("plain text")).toBe(false);
  });

  it("offers each trigger the objects it actually has, and always org and agent", () => {
    expect(templateObjectsFor("approval.created")).toEqual(["org", "agent", "type"]);
    expect(templateObjectsFor("issue.created")).toEqual(["org", "agent", "identifier", "title"]);
    expect(templateObjectsFor("decision.created")).toEqual(["org", "agent"]);
  });

  it("describes every object it offers", () => {
    for (const name of TEMPLATE_OBJECTS) {
      expect(TEMPLATE_OBJECT_HINTS[name]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("serialises an empty message to an empty string, which keeps the built-in wording", () => {
    expect(parseTemplate("")).toEqual([]);
    expect(serializeTemplate([])).toBe("");
  });
});

describe("shouldThrottle", () => {
  it("allows pushes up to the limit and blocks at it", () => {
    expect(shouldThrottle(11, { max: 12 })).toBe(false);
    expect(shouldThrottle(12, { max: 12 })).toBe(true);
  });
});

describe("resolveVapidSubject", () => {
  it("uses the subscription's own https origin", () => {
    expect(resolveVapidSubject("https://paperclip.example.com", "mailto:x@y")).toBe(
      "https://paperclip.example.com",
    );
  });

  it("falls back for http origins, which push services reject as a subject", () => {
    expect(resolveVapidSubject("http://127.0.0.1:3100", "mailto:x@y")).toBe("mailto:x@y");
    expect(resolveVapidSubject(null, "mailto:x@y")).toBe("mailto:x@y");
  });
});
