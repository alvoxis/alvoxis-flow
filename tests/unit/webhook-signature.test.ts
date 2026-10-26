import { describe, expect, it } from "vitest";
import {
  signStripePayload,
  verifyStripeSignature,
} from "@/modules/billing/server/webhook-signature";

/** Stripe webhook signatures: HMAC over "t.payload", constant-time compare, replay window. */
const secret = "whsec_test_secret";
const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
const now = new Date("2026-10-26T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);

describe("verifyStripeSignature", () => {
  it("accepts a correct signature within the tolerance", () => {
    const header = signStripePayload(payload, secret, t);
    expect(verifyStripeSignature({ payload, header, secret, now })).toBe(true);
    // Several v1 entries (secret rotation): one valid is enough.
    const other = signStripePayload(payload, "whsec_other", t).split(",")[1];
    expect(verifyStripeSignature({ payload, header: `${header},${other}`, secret, now })).toBe(
      true,
    );
  });

  it("rejects a changed body, a wrong secret, old timestamps and malformed headers", () => {
    const header = signStripePayload(payload, secret, t);
    expect(verifyStripeSignature({ payload: payload + " ", header, secret, now })).toBe(false);
    expect(verifyStripeSignature({ payload, header, secret: "whsec_wrong", now })).toBe(false);
    const old = signStripePayload(payload, secret, t - 301);
    expect(verifyStripeSignature({ payload, header: old, secret, now })).toBe(false);
    for (const bad of [null, "", "t=abc,v1=00", `v1=${"a".repeat(64)}`, `t=${t}`])
      expect(verifyStripeSignature({ payload, header: bad, secret, now })).toBe(false);
  });
});
