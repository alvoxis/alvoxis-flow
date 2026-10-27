import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { LOCALES } from "@/i18n/config";
import { type Database, type DbOrTx } from "@/server/db/client";
import {
  billingEvents,
  companies,
  companyAccessGrants,
  companyBilling,
  users,
} from "@/server/db/schema";
import { RecordNotFoundError, RecordStateError } from "@/server/records/errors";
import {
  LIVE_STATUSES,
  phaseOf,
  type SubscriptionAccess,
  subscriptionAccess,
  subscriptionEnforced,
  type SubscriptionPhase,
} from "../access";
import { PLAN, type Plan, planOfLookupKey } from "../plans";
import {
  type StripeGateway,
  type StripeInvoiceSnapshot,
  type StripeSubscriptionSnapshot,
} from "./stripe-gateway";

/**
 * Company subscriptions (billing.manage — owners). One plan, PLAN (€9.99 per month), no trial.
 * Stripe is the source of truth: checkout and the customer portal are Stripe-hosted pages, card
 * data never reaches this application, and the cached row is refreshed from Stripe's current
 * subscription list — on verified webhooks, on the billing page and before a checkout. Because the
 * list is re-read instead of applying event payloads, events arriving out of order or twice cannot
 * leave a wrong state behind.
 */

export interface BillingView {
  configured: boolean;
  /** Whether this deployment restricts companies without an active subscription. */
  enforced: boolean;
  hasCustomer: boolean;
  plan: Plan | null;
  status: string | null;
  phase: SubscriptionPhase;
  access: SubscriptionAccess;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** End of an operator's internal access grant (testing, support), if one is active. */
  grantExpiresAt: string | null;
  priceEur: string;
}

export interface BillingInvoiceView {
  id: string;
  number: string | null;
  status: string | null;
  /** Decimal string in the invoice currency, e.g. "9.99". */
  amount: string;
  currency: string;
  created: string;
  url: string | null;
}

/** The subscription that describes the company now: a live one first, else the newest. */
export function currentSubscription(subs: StripeSubscriptionSnapshot[]) {
  const sorted = [...subs].sort((a, b) => b.created.getTime() - a.created.getTime());
  return sorted.find((s) => LIVE_STATUSES.has(s.status)) ?? sorted[0] ?? null;
}

async function sync(db: DbOrTx, gateway: StripeGateway, companyId: string, customerId: string) {
  const subs = await gateway.listSubscriptions(customerId);
  const sub = currentSubscription(subs);
  const before = await loadRow(db, companyId);
  await db
    .update(companyBilling)
    .set({
      stripeSubscriptionId: sub?.id ?? null,
      plan: sub ? planOfLookupKey(sub.lookupKey) : null,
      status: sub?.status ?? null,
      trialEndsAt: sub?.trialEnd ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      ...(subs.some((s) => s.trialEnd !== null) ? { trialUsed: true } : {}),
    })
    .where(eq(companyBilling.companyId, companyId));
  const status = sub?.status ?? null;
  if (before && before.status !== status) {
    // Status changes are part of the company's history (no amounts, no card data).
    await recordAudit(db, {
      companyId,
      actorUserId: null,
      action: "billing.statusChanged",
      entityType: "company",
      entityId: companyId,
      metadata: { from: before.status, to: status },
    });
  }
}

const loadRow = async (db: DbOrTx, companyId: string) =>
  (await db.select().from(companyBilling).where(eq(companyBilling.companyId, companyId)))[0];

const loadGrant = async (db: DbOrTx, companyId: string) =>
  (
    await db
      .select({ expiresAt: companyAccessGrants.expiresAt })
      .from(companyAccessGrants)
      .where(eq(companyAccessGrants.companyId, companyId))
  )[0];

function view(
  configured: boolean,
  row: typeof companyBilling.$inferSelect | undefined,
  grantExpiresAt: Date | null,
): BillingView {
  const status = row?.status ?? null;
  const enforced = subscriptionEnforced();
  const activeGrant = grantExpiresAt && grantExpiresAt > new Date() ? grantExpiresAt : null;
  return {
    configured,
    enforced,
    hasCustomer: Boolean(row),
    plan: row?.plan ? PLAN.id : null,
    status,
    phase: phaseOf(status),
    access: subscriptionAccess({ enforced, status, grantExpiresAt: activeGrant }),
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    grantExpiresAt: activeGrant?.toISOString() ?? null,
    priceEur: PLAN.priceEur,
  };
}

/**
 * The company's billing state, refreshed from Stripe when billing is configured. A Stripe outage
 * shows the last known state instead of failing the page.
 */
export async function billingOverview(
  db: Database,
  gateway: StripeGateway | null,
  actor: Actor,
  companyId: string,
): Promise<BillingView> {
  await requireCompanyAccess(db, actor, companyId, "billing.manage");
  let row = await loadRow(db, companyId);
  if (gateway && row) {
    try {
      await sync(db, gateway, companyId, row.stripeCustomerId);
      row = await loadRow(db, companyId);
    } catch (err) {
      console.error(`[billing] refreshing the subscription failed: ${(err as Error).name}`);
    }
  }
  const grant = await loadGrant(db, companyId);
  return view(Boolean(gateway), row, grant?.expiresAt ?? null);
}

const minorToDecimal = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

/** Stripe invoices of the company (billing.manage): the billing history. Empty without Stripe. */
export async function billingInvoices(
  db: Database,
  gateway: StripeGateway | null,
  actor: Actor,
  companyId: string,
): Promise<BillingInvoiceView[]> {
  await requireCompanyAccess(db, actor, companyId, "billing.manage");
  const row = await loadRow(db, companyId);
  if (!gateway || !row) return [];
  const list: StripeInvoiceSnapshot[] = await gateway.listInvoices(row.stripeCustomerId);
  return list
    .filter((i) => i.status !== "draft")
    .map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      amount: minorToDecimal(i.status === "paid" ? i.amountPaid : i.amountDue),
      currency: i.currency.toUpperCase(),
      created: i.created.toISOString(),
      url: i.hostedInvoiceUrl ?? i.invoicePdf,
    }));
}

const localeSchema = z.enum(LOCALES).default("en");
const checkoutSchema = z.strictObject({
  plan: z.literal(PLAN.id).optional(),
  locale: localeSchema,
});
const portalSchema = z.strictObject({ locale: localeSchema });
const renewalSchema = z.strictObject({ cancel: z.boolean() });

/**
 * Starts a Stripe Checkout for the one plan (billing.manage) and returns its URL. Billing not
 * configured → 409 billing.notConfigured; an existing live subscription → billing.alreadySubscribed
 * (changes go through the portal); the Stripe price missing → billing.priceMissing; a Stripe price
 * that is not €9.99 per month → billing.priceMismatch (nothing is offered at a wrong price).
 */
export async function startCheckout(
  db: Database,
  gateway: StripeGateway | null,
  appUrl: string,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<{ url: string }> {
  await requireCompanyAccess(db, actor, companyId, "billing.manage");
  const { locale } = checkoutSchema.parse(input);
  if (!gateway) throw new RecordStateError("billing.notConfigured");

  let row = await loadRow(db, companyId);
  if (!row) {
    const [owner] = await db
      .select({ company: companies.name, email: users.email })
      .from(companies)
      .innerJoin(users, eq(users.id, actor.userId))
      .where(eq(companies.id, companyId));
    if (!owner) throw new RecordNotFoundError();
    // Idempotent on Stripe's side (key per company) and here (primary key): a double click or a
    // concurrent request ends with one customer.
    const customer = await gateway.createCustomer({
      name: owner.company,
      email: owner.email,
      companyId,
    });
    await db
      .insert(companyBilling)
      .values({ companyId, stripeCustomerId: customer.id })
      .onConflictDoNothing({ target: companyBilling.companyId });
    row = await loadRow(db, companyId);
  }
  if (!row) throw new RecordNotFoundError();
  await sync(db, gateway, companyId, row.stripeCustomerId);
  row = (await loadRow(db, companyId))!;
  if (row.status && LIVE_STATUSES.has(row.status))
    throw new RecordStateError("billing.alreadySubscribed");

  const price = await gateway.findPrice(PLAN.lookupKey);
  if (!price) throw new RecordStateError("billing.priceMissing");
  if (
    price.unitAmount !== PLAN.amountCents ||
    price.currency.toLowerCase() !== PLAN.currency ||
    price.interval !== PLAN.interval
  ) {
    console.error("[billing] the Stripe price does not match the configured plan");
    throw new RecordStateError("billing.priceMismatch");
  }

  const page = `${appUrl.replace(/\/$/, "")}/${locale}/companies/${companyId}/billing`;
  const session = await gateway.createCheckoutSession({
    customerId: row.stripeCustomerId,
    priceId: price.id,
    companyId,
    successUrl: `${page}?checkout=success`,
    cancelUrl: `${page}?checkout=cancelled`,
    locale,
  });
  await recordAudit(db, {
    companyId,
    actorUserId: actor.userId,
    action: "billing.checkoutStarted",
    entityType: "company",
    entityId: companyId,
    metadata: { plan: PLAN.id },
  });
  return session;
}

/** A Stripe customer-portal session for payment methods, invoices and cancellation. */
export async function openPortal(
  db: Database,
  gateway: StripeGateway | null,
  appUrl: string,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<{ url: string }> {
  await requireCompanyAccess(db, actor, companyId, "billing.manage");
  const { locale } = portalSchema.parse(input);
  if (!gateway) throw new RecordStateError("billing.notConfigured");
  const row = await loadRow(db, companyId);
  if (!row) throw new RecordStateError("billing.noCustomer");
  const session = await gateway.createPortalSession({
    customerId: row.stripeCustomerId,
    returnUrl: `${appUrl.replace(/\/$/, "")}/${locale}/companies/${companyId}/billing`,
  });
  await recordAudit(db, {
    companyId,
    actorUserId: actor.userId,
    action: "billing.portalOpened",
    entityType: "company",
    entityId: companyId,
  });
  return session;
}

/**
 * Cancels the renewal at the end of the paid period (`{ cancel: true }`) or resumes it
 * (`{ cancel: false }`) (billing.manage). Access continues until the period ends; no data is
 * deleted. Without a live subscription → 409 billing.noSubscription. The cached row is refreshed
 * from Stripe afterwards, so the answer is Stripe's state.
 */
export async function setRenewal(
  db: Database,
  gateway: StripeGateway | null,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<BillingView> {
  await requireCompanyAccess(db, actor, companyId, "billing.manage");
  const { cancel } = renewalSchema.parse(input);
  if (!gateway) throw new RecordStateError("billing.notConfigured");
  let row = await loadRow(db, companyId);
  if (!row) throw new RecordStateError("billing.noSubscription");
  await sync(db, gateway, companyId, row.stripeCustomerId);
  row = (await loadRow(db, companyId))!;
  if (!row.stripeSubscriptionId || !row.status || !LIVE_STATUSES.has(row.status))
    throw new RecordStateError("billing.noSubscription");
  await gateway.setCancelAtPeriodEnd(row.stripeSubscriptionId, cancel);
  await sync(db, gateway, companyId, row.stripeCustomerId);
  await recordAudit(db, {
    companyId,
    actorUserId: actor.userId,
    action: cancel ? "billing.renewalCancelled" : "billing.renewalResumed",
    entityType: "company",
    entityId: companyId,
  });
  const grant = await loadGrant(db, companyId);
  return view(true, await loadRow(db, companyId), grant?.expiresAt ?? null);
}

/** The webhook events that can change a subscription or report a payment. */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
]);

const eventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

export type WebhookOutcome = "processed" | "duplicate" | "ignored";

/**
 * Applies one verified Stripe event (the caller has checked the signature). Idempotent: the event
 * id is stored in the same transaction, so duplicates do nothing; when refreshing from Stripe fails
 * the transaction rolls back and the error propagates, so Stripe delivers the event again.
 */
export async function handleBillingEvent(
  db: Database,
  gateway: StripeGateway,
  raw: unknown,
): Promise<WebhookOutcome> {
  const event = eventSchema.parse(raw);
  const object = event.data.object;
  const customerId = typeof object.customer === "string" ? object.customer : null;
  return db.transaction(async (tx) => {
    const [row] = customerId
      ? await tx
          .select()
          .from(companyBilling)
          .where(eq(companyBilling.stripeCustomerId, customerId))
      : [];
    const relevant = HANDLED_EVENTS.has(event.type) && row !== undefined;
    const inserted = await tx
      .insert(billingEvents)
      .values({ id: event.id, type: event.type, companyId: relevant ? row!.companyId : null })
      .onConflictDoNothing({ target: billingEvents.id })
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return "duplicate";
    if (!relevant) return "ignored";
    await sync(tx, gateway, row!.companyId, row!.stripeCustomerId);
    if (event.type === "invoice.payment_failed" || event.type === "invoice.payment_action_required")
      await recordAudit(tx, {
        companyId: row!.companyId,
        actorUserId: null,
        action: "billing.paymentFailed",
        entityType: "company",
        entityId: row!.companyId,
        metadata: { event: event.type },
      });
    return "processed";
  });
}

/** Whether the company has an internal access grant that is still valid (for admin views). */
export async function activeGrant(db: DbOrTx, companyId: string) {
  const [g] = await db
    .select()
    .from(companyAccessGrants)
    .where(and(eq(companyAccessGrants.companyId, companyId)));
  return g && g.expiresAt > new Date() ? g : null;
}
