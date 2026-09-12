import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  buildNotification,
  resolveVapidSubject,
  planDelivery,
  shouldThrottle,
  type SubscriptionTarget,
} from "../src/notifications.js";

function event(overrides: Partial<PluginEvent> = {}): PluginEvent {
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
  } as PluginEvent;
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
      companySubscriptions: [],
      responsibleSubscriptions: [registeredElsewhere],
      event: event({ companyId: "company-1", payload: { responsibleUserId: "user-1" } }),
    });
    expect(recipients.map((entry) => entry.id)).toEqual(["elsewhere"]);
  });

  it("notifies only the named responsible user, not their colleagues", () => {
    const recipients = planDelivery({
      companySubscriptions: [subscription({ id: "theirs", userId: "user-2" })],
      responsibleSubscriptions: [
        subscription({ id: "mine", userId: "user-1" }),
        subscription({ id: "theirs", userId: "user-2" }),
      ],
      event: event({ payload: { responsibleUserId: "user-1" } }),
    });
    expect(recipients.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("keeps the unassigned fallback inside the event's own company", () => {
    // An unassigned budget incident must not buzz another company's subscribers.
    const recipients = planDelivery({
      companySubscriptions: [
        subscription({ id: "here", companyId: "company-1" }),
        subscription({ id: "there", companyId: "company-2" }),
      ],
      event: event({ eventType: "budget.incident.opened", payload: {} }),
    });
    expect(recipients.map((entry) => entry.id)).toEqual(["here"]);
  });

  it("stays silent when unassigned and broadcasting is disabled", () => {
    const recipients = planDelivery({
      companySubscriptions: [subscription()],
      event: event({ payload: {} }),
      broadcastWhenUnassigned: false,
    });
    expect(recipients).toEqual([]);
  });

  it("honours the enabled flag and per-device event choices", () => {
    const recipients = planDelivery({
      companySubscriptions: [],
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
      companySubscriptions: [],
      responsibleSubscriptions: [subscription({ userId: "user-1", eventTypes: [] })],
      event: event({ payload: { responsibleUserId: "user-1" } }),
    });
    expect(recipients).toHaveLength(1);
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
