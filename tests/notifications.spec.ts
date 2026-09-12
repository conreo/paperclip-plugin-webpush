import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  buildNotification,
  resolveVapidSubject,
  selectRecipients,
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

describe("selectRecipients", () => {
  it("targets only the responsible user when the event names one", () => {
    const mine = subscription({ id: "mine", userId: "user-1" });
    const someoneElse = subscription({ id: "theirs", userId: "user-2" });
    const recipients = selectRecipients(
      [mine, someoneElse],
      event({ payload: { responsibleUserId: "user-1" } }),
    );
    expect(recipients.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("broadcasts within the company when no responsible user is set", () => {
    const first = subscription({ id: "a", userId: "user-1" });
    const second = subscription({ id: "b", userId: "user-2" });
    const recipients = selectRecipients([first, second], event({ payload: {} }));
    expect(recipients).toHaveLength(2);
  });

  it("stays silent when broadcasting is disabled and no user is named", () => {
    const recipients = selectRecipients([subscription()], event({ payload: {} }), {
      broadcastWhenUnassigned: false,
    });
    expect(recipients).toEqual([]);
  });

  it("respects company scope, the enabled flag, and per-device event choices", () => {
    const otherCompany = subscription({ id: "other-company", companyId: "company-2" });
    const disabled = subscription({ id: "disabled", enabled: false });
    const optedOut = subscription({ id: "opted-out", eventTypes: ["budget.incident.opened"] });
    const optedIn = subscription({ id: "opted-in", eventTypes: ["approval.created"] });

    const recipients = selectRecipients(
      [otherCompany, disabled, optedOut, optedIn],
      event({ payload: { responsibleUserId: "user-1" } }),
    );

    expect(recipients.map((entry) => entry.id)).toEqual(["opted-in"]);
  });

  it("treats an empty event list as 'everything'", () => {
    const recipients = selectRecipients([subscription()], event({ payload: { responsibleUserId: "user-1" } }));
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
