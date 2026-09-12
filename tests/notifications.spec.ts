import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_EVENT_TYPES,
  activeUserMemberIds,
  NOTIFIABLE_EVENT_TYPES,
  buildNotification,
  previewDefaults,
  renderTemplate,
  resolvePluginConfig,
  resolvePresentation,
  resolveVapidSubject,
  planDelivery,
  shouldThrottle,
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
      title: "Decision needed",
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
    expect(notification?.title).toBe("Decision overdue");
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
      title: "Approval needed",
      url: "/ACME/approvals/appr-9",
      tag: "approval.created",
      eventId: "evt-1",
    });
  });

  it("falls back to an unprefixed link when the prefix is unknown", () => {
    const notification = buildNotification(event({ entityId: "appr-9" }), null);
    expect(notification?.url).toBe("/approvals/appr-9");
  });

  it("prefers the issue id on a failed run", () => {
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
    expect(notification?.body).toContain("12345678");
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
    expect(notification?.title).toBe("New task ACME-42");
    expect(notification?.body).toBe("Ship the thing");
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
  it("defaults to the organization name and to showing it", () => {
    const presentation = resolvePresentation(null, "Acme");
    expect(presentation).toMatchObject({ organizationLabel: "Acme", includeOrganizationLabel: true });
    expect(presentation.templates).toEqual({});
  });

  it("prefers a configured label and honours the toggle", () => {
    const presentation = resolvePresentation(
      { organizationLabel: "  Acme Ops  ", includeOrganizationLabel: false },
      "Acme",
    );
    expect(presentation.organizationLabel).toBe("Acme Ops");
    expect(presentation.includeOrganizationLabel).toBe(false);
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

  it("ignores a non-boolean toggle rather than treating words as true", () => {
    expect(resolvePresentation({ includeOrganizationLabel: "false" }, "Acme").includeOrganizationLabel).toBe(true);
  });
});

describe("buildNotification with configured text", () => {
  const presentation = (overrides: Partial<Parameters<typeof buildNotification>[2]> = {}) => ({
    organizationLabel: "Acme",
    includeOrganizationLabel: true,
    templates: {},
    ...overrides,
  });

  it("prefixes the organization name", () => {
    const notification = buildNotification(event(), "ACME", presentation());
    expect(notification?.title).toBe("Acme · Approval needed");
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
    expect(notification?.title).toBe("Acme · Approval needed");
    expect(notification?.body).toBe("A request is waiting for a decision.");
  });

  it("can omit the label entirely", () => {
    const notification = buildNotification(event(), "ACME", presentation({ includeOrganizationLabel: false }));
    expect(notification?.title).toBe("Approval needed");
  });

  it("previews the built-in wording for the settings page", () => {
    expect(previewDefaults("approval.created")).toEqual({
      title: "Approval needed",
      body: "A request is waiting for a decision.",
    });
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
