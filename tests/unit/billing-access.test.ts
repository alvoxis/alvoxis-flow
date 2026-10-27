import { describe, expect, it } from "vitest";
import { phaseOf, subscriptionAccess, subscriptionEnforced } from "@/modules/billing/access";
import { LEGACY_LOOKUP_KEYS, PLAN, planOfLookupKey } from "@/modules/billing/plans";
import { PAID_PERMISSIONS, PERMISSIONS } from "@/server/auth/permissions";

/** The subscription policy: one plan, which statuses grant access, and when it is enforced. */
describe("billing plan", () => {
  it("has exactly one plan at €9.99 per month and maps legacy prices to it", () => {
    expect(PLAN).toMatchObject({
      id: "flow",
      priceEur: "9.99",
      amountCents: 999,
      interval: "month",
    });
    expect(planOfLookupKey(PLAN.lookupKey)).toBe("flow");
    for (const key of LEGACY_LOOKUP_KEYS) expect(planOfLookupKey(key)).toBe("flow");
    expect(planOfLookupKey("someone_else_monthly")).toBeNull();
    expect(planOfLookupKey(null)).toBeNull();
  });
});

describe("subscription access", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const access = (status: string | null, grantExpiresAt: Date | null = null, enforced = true) =>
    subscriptionAccess({ enforced, status, grantExpiresAt, now });

  it("grants full access for active, legacy trialing and past_due (Stripe retries)", () => {
    expect(access("active")).toBe("full");
    expect(access("trialing")).toBe("full");
    expect(access("past_due")).toBe("full");
  });

  it("is read-only without a paid subscription", () => {
    for (const s of [null, "incomplete", "incomplete_expired", "unpaid", "paused", "canceled", "x"])
      expect(access(s)).toBe("read_only");
  });

  it("honours only unexpired operator grants and never restricts when not enforced", () => {
    expect(access("canceled", new Date("2026-10-27T00:00:00Z"))).toBe("full");
    expect(access("canceled", new Date("2026-10-26T11:59:59Z"))).toBe("read_only");
    expect(access(null, null, false)).toBe("full");
  });

  it("describes each status as a phase", () => {
    expect(phaseOf("active")).toBe("active");
    expect(phaseOf("past_due")).toBe("past_due");
    expect(phaseOf("incomplete")).toBe("awaiting_payment");
    expect(phaseOf("unpaid")).toBe("payment_required");
    expect(phaseOf("canceled")).toBe("ended");
    expect(phaseOf(null)).toBe("none");
  });

  it("is enforced with Stripe configured unless explicitly switched", () => {
    expect(subscriptionEnforced({})).toBe(false);
    expect(subscriptionEnforced({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe(true);
    expect(
      subscriptionEnforced({ STRIPE_SECRET_KEY: "sk_test_x", SUBSCRIPTION_ENFORCEMENT: "off" }),
    ).toBe(false);
    expect(subscriptionEnforced({ SUBSCRIPTION_ENFORCEMENT: "on" })).toBe(true);
  });

  it("withholds only permissions that change data or use the assistant", () => {
    for (const p of PAID_PERMISSIONS) expect(PERMISSIONS).toContain(p);
    for (const p of PAID_PERMISSIONS) expect(p.endsWith(".view")).toBe(false);
    for (const p of [
      "billing.manage",
      "members.manage",
      "company.manage",
      "documents.view",
    ] as const)
      expect(PAID_PERMISSIONS.has(p)).toBe(false);
  });
});
