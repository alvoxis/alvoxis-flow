import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, companyBilling } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import {
  type StripeGateway,
  StripeRequestError,
  type StripeSubscriptionSnapshot,
} from "@/modules/billing/server/stripe-gateway";
import { call, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Subscriptions over the real route handlers, service and database with a fake Stripe gateway
 * (nothing reaches Stripe): one customer per company, the one free trial, plan checkout, the
 * portal, refresh from Stripe, owners only, not configured and provider failures.
 */
const session = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: null as { userId: string; twoFactorVerified: boolean } | null,
  gateway: null as unknown,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/auth/instance", () => ({ getAuth: () => ({}) }));
vi.mock("@/modules/billing/server/gateway", () => ({ getStripeGateway: () => session.gateway }));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServerEnv: () => ({ APP_URL: "https://app.example.test" }),
}));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => session.db,
}));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireUser: async () => {
    if (!session.actor) throw new UnauthenticatedError();
    return { ...session.actor, sessionId: "test-session" };
  },
}));

const billingRoute = await import("@/app/api/companies/[companyId]/billing/route");
const checkoutRoute = await import("@/app/api/companies/[companyId]/billing/checkout/route");
const portalRoute = await import("@/app/api/companies/[companyId]/billing/portal/route");

let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  session.db = db;
});
afterAll(async () => pool.end());

/** An in-memory Stripe: customers, prices by lookup key, subscriptions the test sets. */
function fakeStripe() {
  // Stripe customer ids are unique across all tests sharing the database.
  const prefix = randomUUID().slice(0, 8);
  const state = {
    customers: [] as { id: string; companyId: string }[],
    checkouts: [] as Parameters<StripeGateway["createCheckoutSession"]>[0][],
    subscriptions: new Map<string, StripeSubscriptionSnapshot[]>(),
    fail: false,
  };
  const gateway: StripeGateway = {
    async createCustomer({ companyId }) {
      if (state.fail) throw new StripeRequestError(500, "api_error");
      const id = `cus_${prefix}_${state.customers.length + 1}`;
      state.customers.push({ id, companyId });
      return { id };
    },
    async findPrice(lookupKey) {
      return lookupKey.startsWith("alvoxis_flow_") ? { id: `price_${lookupKey}` } : null;
    },
    async createCheckoutSession(input) {
      state.checkouts.push(input);
      return { url: `https://checkout.stripe.test/${state.checkouts.length}` };
    },
    async createPortalSession({ customerId }) {
      return { url: `https://billing.stripe.test/${customerId}` };
    },
    async listSubscriptions(customerId) {
      if (state.fail) throw new StripeRequestError(500, "api_error");
      return state.subscriptions.get(customerId) ?? [];
    },
  };
  return { state, gateway };
}

const h = routeHelpers(() => db);
const as = (actor: Actor | null) => {
  session.actor = actor;
};
const api = {
  get: (companyId: string) => call(billingRoute.GET(req("GET"), params({ companyId }))),
  checkout: (companyId: string, body: unknown) =>
    call(checkoutRoute.POST(req("POST", body), params({ companyId }))),
  portal: (companyId: string, body: unknown = {}) =>
    call(portalRoute.POST(req("POST", body), params({ companyId }))),
};
const sub = (over: Partial<StripeSubscriptionSnapshot>): StripeSubscriptionSnapshot => ({
  id: "sub_1",
  status: "trialing",
  lookupKey: "alvoxis_flow_pro_monthly",
  trialEnd: new Date("2026-10-26T00:00:00Z"),
  currentPeriodEnd: new Date("2026-10-26T00:00:00Z"),
  cancelAtPeriodEnd: false,
  created: new Date("2026-10-24T00:00:00Z"),
  ...over,
});

let stripe: ReturnType<typeof fakeStripe>;
beforeEach(() => {
  stripe = fakeStripe();
  session.gateway = stripe.gateway;
  session.actor = null;
});

describe("billing", () => {
  it("checks out with the one free trial, then reflects the subscription from Stripe", async () => {
    const c = await h.newCompany("Abonements SIA");
    as(c.owner);
    expect((await api.get(c.companyId)).body.billing).toMatchObject({
      configured: true,
      hasCustomer: false,
      plan: null,
      trialAvailable: true,
    });

    const first = await api.checkout(c.companyId, { plan: "pro", locale: "lv" });
    expect(first).toEqual({ status: 200, body: { url: "https://checkout.stripe.test/1" } });
    const customer = stripe.state.customers[0]!.id;
    expect(stripe.state.customers).toEqual([{ id: customer, companyId: c.companyId }]);
    expect(stripe.state.checkouts[0]).toMatchObject({
      customerId: customer,
      priceId: "price_alvoxis_flow_pro_monthly",
      trialDays: 2,
      locale: "lv",
      successUrl: `https://app.example.test/lv/companies/${c.companyId}/billing?checkout=success`,
    });

    // The customer finished checkout: Stripe now has a trialing subscription.
    stripe.state.subscriptions.set(customer, [sub({})]);
    const view = (await api.get(c.companyId)).body.billing;
    expect(view).toMatchObject({
      plan: "pro",
      status: "trialing",
      trialEndsAt: "2026-10-26T00:00:00.000Z",
      trialAvailable: false,
    });
    // A live subscription is changed in the portal, not by a second checkout.
    expect((await api.checkout(c.companyId, { plan: "basic" })).body).toMatchObject({
      error: "invalid_state",
      code: "billing.alreadySubscribed",
    });
    expect((await api.portal(c.companyId, { locale: "ru" })).body).toEqual({
      url: `https://billing.stripe.test/${customer}`,
    });

    // The trial ended without a card: Stripe cancelled it. A new checkout is paid, no new trial,
    // and the same Stripe customer is reused.
    stripe.state.subscriptions.set(customer, [sub({ status: "canceled" })]);
    expect((await api.get(c.companyId)).body.billing).toMatchObject({
      status: "canceled",
      trialAvailable: false,
    });
    await api.checkout(c.companyId, { plan: "business" });
    expect(stripe.state.checkouts[1]).toMatchObject({ trialDays: null, customerId: customer });
    expect(stripe.state.customers).toHaveLength(1);

    const audits = await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.companyId, c.companyId), eq(auditLogs.action, "billing.checkoutStarted")),
      );
    expect(audits.map((a) => a.metadata)).toEqual([
      { plan: "pro", trial: true },
      { plan: "business", trial: false },
    ]);
  });

  it("validates input, allows owners only and isolates companies", async () => {
    const c = await h.newCompany();
    const other = await h.newCompany();
    as(c.owner);
    expect((await api.checkout(c.companyId, { plan: "gold" })).status).toBe(422);
    expect((await api.checkout(c.companyId, { plan: "pro", extra: 1 })).status).toBe(422);
    expect((await api.portal(c.companyId)).body).toMatchObject({ code: "billing.noCustomer" });
    for (const role of ["administrator", "accountant", "manager"]) {
      as(await h.member(c.companyId, role));
      expect((await api.get(c.companyId)).status).toBe(403);
      expect((await api.checkout(c.companyId, { plan: "pro" })).status).toBe(403);
    }
    as(other.owner);
    expect((await api.get(c.companyId)).status).toBe(403);
    as(null);
    expect((await api.get(c.companyId)).status).toBe(401);
    expect(stripe.state.customers).toHaveLength(0);
  });

  it("works without Stripe configured and survives provider failures", async () => {
    const c = await h.newCompany();
    as(c.owner);
    session.gateway = null;
    expect((await api.get(c.companyId)).body.billing).toMatchObject({ configured: false });
    expect((await api.checkout(c.companyId, { plan: "pro" })).body).toMatchObject({
      code: "billing.notConfigured",
    });

    session.gateway = stripe.gateway;
    await api.checkout(c.companyId, { plan: "basic" });
    stripe.state.fail = true;
    // The page still shows the last known state when Stripe does not answer.
    expect((await api.get(c.companyId)).status).toBe(200);
    expect((await api.checkout(c.companyId, { plan: "basic" })).status).toBe(502);
    const [row] = await db
      .select()
      .from(companyBilling)
      .where(eq(companyBilling.companyId, c.companyId));
    expect(row?.stripeCustomerId).toBe(stripe.state.customers[0]!.id);
  });
});
