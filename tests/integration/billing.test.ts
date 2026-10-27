import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, billingEvents, companyAccessGrants, companyBilling } from "@/server/db/schema";
import { signStripePayload } from "@/modules/billing/server/webhook-signature";
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
 * (nothing reaches Stripe): one plan without a trial, price verification, the portal, renewal,
 * billing history, verified and idempotent webhooks, read-only access without a subscription,
 * owners only, not configured and provider failures.
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
  getServerEnv: () => ({
    APP_URL: "https://app.example.test",
    STRIPE_WEBHOOK_SECRET: "whsec_test_integration",
  }),
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
const renewalRoute = await import("@/app/api/companies/[companyId]/billing/renewal/route");
const invoicesRoute = await import("@/app/api/companies/[companyId]/billing/invoices/route");
const webhookRoute = await import("@/app/api/billing/webhook/route");
const productsRoute = await import("@/app/api/companies/[companyId]/products/route");

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
    price: {
      unitAmount: 999 as number | null,
      currency: "eur",
      interval: "month" as string | null,
    },
    cancelCalls: [] as { id: string; cancel: boolean }[],
  };
  const gateway: StripeGateway = {
    async createCustomer({ companyId }) {
      if (state.fail) throw new StripeRequestError(500, "api_error");
      const id = `cus_${prefix}_${state.customers.length + 1}`;
      state.customers.push({ id, companyId });
      return { id };
    },
    async findPrice(lookupKey) {
      return lookupKey === "alvoxis_flow_monthly"
        ? { id: `price_${lookupKey}`, ...state.price }
        : null;
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
    async listInvoices() {
      if (state.fail) throw new StripeRequestError(500, "api_error");
      return [
        {
          id: "in_1",
          number: "AF-0001",
          status: "paid",
          amountDue: 999,
          amountPaid: 999,
          currency: "eur",
          created: new Date("2026-10-01T00:00:00Z"),
          hostedInvoiceUrl: "https://invoice.stripe.test/in_1",
          invoicePdf: null,
        },
      ];
    },
    async setCancelAtPeriodEnd(id, cancel) {
      state.cancelCalls.push({ id, cancel });
      for (const [customer, subs] of state.subscriptions)
        state.subscriptions.set(
          customer,
          subs.map((x) => (x.id === id ? { ...x, cancelAtPeriodEnd: cancel } : x)),
        );
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
  renewal: (companyId: string, body: unknown) =>
    call(renewalRoute.POST(req("POST", body), params({ companyId }))),
  invoices: (companyId: string) => call(invoicesRoute.GET(req("GET"), params({ companyId }))),
  createProduct: (companyId: string, name: string) =>
    call(productsRoute.POST(req("POST", { name }), params({ companyId }))),
  listProducts: (companyId: string) =>
    call(productsRoute.GET(req("GET", undefined, "http://localhost/api"), params({ companyId }))),
};

const WEBHOOK_SECRET = "whsec_test_integration";
/** Delivers a webhook like Stripe: the raw body with a signature header (or a given one). */
async function deliver(event: object, header?: string) {
  const payload = JSON.stringify(event);
  const sig = header ?? signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
  return call(
    webhookRoute.POST(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body: payload,
      }),
    ),
  );
}
const evt = (id: string, type: string, customer: string) => ({
  id,
  type,
  data: { object: { id: "obj_1", customer } },
});
const sub = (over: Partial<StripeSubscriptionSnapshot>): StripeSubscriptionSnapshot => ({
  id: "sub_1",
  status: "active",
  lookupKey: "alvoxis_flow_monthly",
  trialEnd: null,
  currentPeriodEnd: new Date("2026-11-24T00:00:00Z"),
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
  it("checks out the one plan without a trial, then reflects the subscription from Stripe", async () => {
    const c = await h.newCompany("Abonements SIA");
    as(c.owner);
    expect((await api.get(c.companyId)).body.billing).toMatchObject({
      configured: true,
      hasCustomer: false,
      plan: null,
      phase: "none",
      priceEur: "9.99",
    });

    const first = await api.checkout(c.companyId, { locale: "lv" });
    expect(first).toEqual({ status: 200, body: { url: "https://checkout.stripe.test/1" } });
    const customer = stripe.state.customers[0]!.id;
    expect(stripe.state.customers).toEqual([{ id: customer, companyId: c.companyId }]);
    expect(stripe.state.checkouts[0]).toEqual({
      customerId: customer,
      priceId: "price_alvoxis_flow_monthly",
      companyId: c.companyId,
      locale: "lv",
      successUrl: `https://app.example.test/lv/companies/${c.companyId}/billing?checkout=success`,
      cancelUrl: `https://app.example.test/lv/companies/${c.companyId}/billing?checkout=cancelled`,
    });

    // The customer paid: Stripe now has an active subscription.
    stripe.state.subscriptions.set(customer, [sub({})]);
    expect((await api.get(c.companyId)).body.billing).toMatchObject({
      plan: "flow",
      status: "active",
      phase: "active",
      access: "full",
      currentPeriodEnd: "2026-11-24T00:00:00.000Z",
    });
    expect((await api.checkout(c.companyId, {})).body).toMatchObject({
      error: "invalid_state",
      code: "billing.alreadySubscribed",
    });
    expect((await api.portal(c.companyId, { locale: "ru" })).body).toEqual({
      url: `https://billing.stripe.test/${customer}`,
    });
    expect((await api.invoices(c.companyId)).body.invoices).toEqual([
      {
        id: "in_1",
        number: "AF-0001",
        status: "paid",
        amount: "9.99",
        currency: "EUR",
        created: "2026-10-01T00:00:00.000Z",
        url: "https://invoice.stripe.test/in_1",
      },
    ]);

    // Ended: a new checkout reuses the same Stripe customer.
    stripe.state.subscriptions.set(customer, [sub({ status: "canceled" })]);
    expect((await api.get(c.companyId)).body.billing).toMatchObject({ phase: "ended" });
    await api.checkout(c.companyId, {});
    expect(stripe.state.customers).toHaveLength(1);

    const audits = await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.companyId, c.companyId));
    const actions = audits.map((a) => a.action);
    expect(actions.filter((a) => a === "billing.checkoutStarted")).toHaveLength(2);
    expect(audits.find((a) => a.action === "billing.checkoutStarted")?.metadata).toEqual({
      plan: "flow",
    });
    expect(
      audits.filter((a) => a.action === "billing.statusChanged").map((a) => a.metadata),
    ).toEqual([
      { from: null, to: "active" },
      { from: "active", to: "canceled" },
    ]);
  });

  it("refuses a missing or wrongly configured Stripe price", async () => {
    const c = await h.newCompany();
    as(c.owner);
    stripe.state.price = { unitAmount: 1299, currency: "eur", interval: "month" };
    expect((await api.checkout(c.companyId, {})).body).toMatchObject({
      code: "billing.priceMismatch",
    });
    stripe.state.price = { unitAmount: 999, currency: "eur", interval: "year" };
    expect((await api.checkout(c.companyId, {})).body).toMatchObject({
      code: "billing.priceMismatch",
    });
    stripe.state.price = { unitAmount: 999, currency: "usd", interval: "month" };
    expect((await api.checkout(c.companyId, {})).body).toMatchObject({
      code: "billing.priceMismatch",
    });
    expect(stripe.state.checkouts).toHaveLength(0);
  });

  it("cancels and resumes the renewal through Stripe", async () => {
    const c = await h.newCompany();
    as(c.owner);
    expect((await api.renewal(c.companyId, { cancel: true })).body).toMatchObject({
      code: "billing.noSubscription",
    });
    await api.checkout(c.companyId, {});
    const customer = stripe.state.customers[0]!.id;
    stripe.state.subscriptions.set(customer, [sub({ id: "sub_r" })]);
    const cancelled = await api.renewal(c.companyId, { cancel: true });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.billing).toMatchObject({ cancelAtPeriodEnd: true, access: "full" });
    const resumed = await api.renewal(c.companyId, { cancel: false });
    expect(resumed.body.billing).toMatchObject({ cancelAtPeriodEnd: false });
    expect(stripe.state.cancelCalls).toEqual([
      { id: "sub_r", cancel: true },
      { id: "sub_r", cancel: false },
    ]);
    expect((await api.renewal(c.companyId, { cancel: "yes" })).status).toBe(422);
  });

  it("validates input, allows owners only and isolates companies", async () => {
    const c = await h.newCompany();
    const other = await h.newCompany();
    as(c.owner);
    expect((await api.checkout(c.companyId, { plan: "gold" })).status).toBe(422);
    expect((await api.checkout(c.companyId, { plan: "pro" })).status).toBe(422);
    expect((await api.checkout(c.companyId, { extra: 1 })).status).toBe(422);
    expect((await api.portal(c.companyId)).body).toMatchObject({ code: "billing.noCustomer" });
    for (const role of ["administrator", "accountant", "manager"]) {
      as(await h.member(c.companyId, role));
      expect((await api.get(c.companyId)).status).toBe(403);
      expect((await api.checkout(c.companyId, {})).status).toBe(403);
      expect((await api.renewal(c.companyId, { cancel: true })).status).toBe(403);
      expect((await api.invoices(c.companyId)).status).toBe(403);
    }
    as(other.owner);
    expect((await api.get(c.companyId)).status).toBe(403);
    expect((await api.invoices(c.companyId)).status).toBe(403);
    as(null);
    expect((await api.get(c.companyId)).status).toBe(401);
    expect(stripe.state.customers).toHaveLength(0);
  });

  it("works without Stripe configured and survives provider failures", async () => {
    const c = await h.newCompany();
    as(c.owner);
    session.gateway = null;
    expect((await api.get(c.companyId)).body.billing).toMatchObject({ configured: false });
    expect((await api.checkout(c.companyId, {})).body).toMatchObject({
      code: "billing.notConfigured",
    });
    expect((await api.invoices(c.companyId)).body.invoices).toEqual([]);

    session.gateway = stripe.gateway;
    await api.checkout(c.companyId, {});
    stripe.state.fail = true;
    // The page still shows the last known state when Stripe does not answer.
    expect((await api.get(c.companyId)).status).toBe(200);
    expect((await api.checkout(c.companyId, {})).status).toBe(502);
    const [row] = await db
      .select()
      .from(companyBilling)
      .where(eq(companyBilling.companyId, c.companyId));
    expect(row?.stripeCustomerId).toBe(stripe.state.customers[0]!.id);
  });
});

describe("billing webhooks", () => {
  it("accepts only correctly signed events", async () => {
    expect(
      (await deliver(evt("evt_x", "invoice.paid", "cus_x"), "t=1,v1=" + "0".repeat(64))).status,
    ).toBe(400);
    expect((await deliver(evt("evt_x", "invoice.paid", "cus_x"), "")).status).toBe(400);
    const stale = signStripePayload(
      JSON.stringify(evt("evt_x", "invoice.paid", "cus_x")),
      WEBHOOK_SECRET,
      Math.floor(Date.now() / 1000) - 3600,
    );
    expect((await deliver(evt("evt_x", "invoice.paid", "cus_x"), stale)).status).toBe(400);
    session.gateway = null;
    expect((await deliver(evt("evt_x", "invoice.paid", "cus_x"))).status).toBe(503);
    const stored = await db.select().from(billingEvents).where(eq(billingEvents.id, "evt_x"));
    expect(stored).toHaveLength(0);
  });

  it("applies Stripe's current state once per event, whatever the order", async () => {
    const c = await h.newCompany();
    as(c.owner);
    await api.checkout(c.companyId, {});
    const customer = stripe.state.customers[0]!.id;
    const id = randomUUID();

    // "updated → active" arrives after "deleted" was already true at Stripe: the row follows
    // Stripe's list, not the order of events.
    stripe.state.subscriptions.set(customer, [sub({ status: "canceled" })]);
    const late = await deliver(evt(`evt_${id}_1`, "customer.subscription.updated", customer));
    expect(late.body).toEqual({ received: true, outcome: "processed" });
    const [row] = await db
      .select()
      .from(companyBilling)
      .where(eq(companyBilling.companyId, c.companyId));
    expect(row?.status).toBe("canceled");

    stripe.state.subscriptions.set(customer, [sub({ status: "past_due" })]);
    expect(
      (await deliver(evt(`evt_${id}_2`, "invoice.payment_failed", customer))).body.outcome,
    ).toBe("processed");
    // A redelivery does nothing (no second audit entry).
    expect(
      (await deliver(evt(`evt_${id}_2`, "invoice.payment_failed", customer))).body.outcome,
    ).toBe("duplicate");
    const failed = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.companyId, c.companyId), eq(auditLogs.action, "billing.paymentFailed")),
      );
    expect(failed).toHaveLength(1);

    // Unknown customers and unrelated event types are stored once and ignored.
    expect((await deliver(evt(`evt_${id}_3`, "invoice.paid", "cus_unknown"))).body.outcome).toBe(
      "ignored",
    );
    expect((await deliver(evt(`evt_${id}_4`, "customer.created", customer))).body.outcome).toBe(
      "ignored",
    );
  });

  it("does not record an event whose processing failed, so Stripe's retry applies it", async () => {
    const c = await h.newCompany();
    as(c.owner);
    await api.checkout(c.companyId, {});
    const customer = stripe.state.customers[0]!.id;
    const id = `evt_${randomUUID()}`;
    stripe.state.fail = true;
    expect((await deliver(evt(id, "invoice.paid", customer))).status).toBe(500);
    expect(await db.select().from(billingEvents).where(eq(billingEvents.id, id))).toHaveLength(0);
    stripe.state.fail = false;
    stripe.state.subscriptions.set(customer, [sub({})]);
    expect((await deliver(evt(id, "invoice.paid", customer))).body.outcome).toBe("processed");
    const [row] = await db
      .select()
      .from(companyBilling)
      .where(eq(companyBilling.companyId, c.companyId));
    expect(row?.status).toBe("active");
  });
});

describe("subscription enforcement", () => {
  beforeEach(() => vi.stubEnv("SUBSCRIPTION_ENFORCEMENT", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("makes a company without a paid subscription read-only, and restores it on payment", async () => {
    const c = await h.newCompany();
    as(c.owner);
    // Without a subscription: reading works, changing returns 402, billing stays reachable.
    expect((await api.listProducts(c.companyId)).status).toBe(200);
    expect(await api.createProduct(c.companyId, "Pārtika")).toEqual({
      status: 402,
      body: { error: "subscription_required" },
    });
    expect((await api.get(c.companyId)).body.billing).toMatchObject({
      enforced: true,
      access: "read_only",
    });

    await api.checkout(c.companyId, {});
    const customer = stripe.state.customers[0]!.id;
    // Awaiting the first payment is still read-only.
    stripe.state.subscriptions.set(customer, [sub({ status: "incomplete" })]);
    await deliver(evt(`evt_${randomUUID()}`, "checkout.session.completed", customer));
    expect((await api.createProduct(c.companyId, "Pārtika")).status).toBe(402);

    // Stripe confirms the payment.
    stripe.state.subscriptions.set(customer, [sub({ status: "active" })]);
    await deliver(evt(`evt_${randomUUID()}`, "invoice.paid", customer));
    expect((await api.createProduct(c.companyId, "Pārtika")).status).toBe(201);

    // Past due keeps access while Stripe retries; ended subscriptions are read-only again,
    // and the data created before stays readable.
    stripe.state.subscriptions.set(customer, [sub({ status: "past_due" })]);
    await deliver(evt(`evt_${randomUUID()}`, "invoice.payment_failed", customer));
    expect((await api.createProduct(c.companyId, "Maize")).status).toBe(201);
    stripe.state.subscriptions.set(customer, [sub({ status: "canceled" })]);
    await deliver(evt(`evt_${randomUUID()}`, "customer.subscription.deleted", customer));
    expect((await api.createProduct(c.companyId, "Siers")).status).toBe(402);
    expect((await api.listProducts(c.companyId)).body.products).toHaveLength(2);
  });

  it("honours an unexpired internal access grant", async () => {
    const c = await h.newCompany();
    as(c.owner);
    await db.insert(companyAccessGrants).values({
      companyId: c.companyId,
      reason: "QA test company",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect((await api.createProduct(c.companyId, "Tests")).status).toBe(201);
    await db
      .update(companyAccessGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(companyAccessGrants.companyId, c.companyId));
    expect((await api.createProduct(c.companyId, "Tests 2")).status).toBe(402);
  });
});
