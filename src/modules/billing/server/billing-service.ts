import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { LOCALES } from "@/i18n/config";
import { type Database, type DbOrTx } from "@/server/db/client";
import { companies, companyBilling, users } from "@/server/db/schema";
import { RecordNotFoundError, RecordStateError } from "@/server/records/errors";
import { lookupKeyOf, type Plan, PLANS, TRIAL_DAYS } from "../plans";
import { type StripeGateway, type StripeSubscriptionSnapshot } from "./stripe-gateway";

/**
 * Company subscriptions (billing.manage — owners). Stripe is the source of truth: checkout and the
 * customer portal are Stripe-hosted pages, card data never reaches this application, and the cached
 * row is refreshed from Stripe whenever the billing page loads. A company gets one free trial of
 * TRIAL_DAYS without a card; it ends instead of becoming paid unless a payment method is added.
 */

const planOfLookupKey = (key: string | null): Plan | null =>
  PLANS.find((p) => lookupKeyOf(p) === key) ?? null;

/** Statuses in which the company has a subscription that is managed in the portal. */
const LIVE_STATUSES = new Set(["trialing", "active", "past_due", "unpaid", "incomplete", "paused"]);

export interface BillingView {
  configured: boolean;
  hasCustomer: boolean;
  plan: Plan | null;
  status: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialAvailable: boolean;
}

/** The subscription that describes the company now: a live one first, else the newest. */
function currentSubscription(subs: StripeSubscriptionSnapshot[]) {
  const sorted = [...subs].sort((a, b) => b.created.getTime() - a.created.getTime());
  return sorted.find((s) => LIVE_STATUSES.has(s.status)) ?? sorted[0] ?? null;
}

async function sync(db: DbOrTx, gateway: StripeGateway, companyId: string, customerId: string) {
  const subs = await gateway.listSubscriptions(customerId);
  const sub = currentSubscription(subs);
  await db
    .update(companyBilling)
    .set({
      stripeSubscriptionId: sub?.id ?? null,
      plan: sub ? planOfLookupKey(sub.lookupKey) : null,
      status: sub?.status ?? null,
      trialEndsAt: sub?.trialEnd ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      // Any subscription that ever had a trial uses the company's one trial.
      ...(subs.some((s) => s.trialEnd !== null) ? { trialUsed: true } : {}),
    })
    .where(eq(companyBilling.companyId, companyId));
}

function view(
  configured: boolean,
  row: typeof companyBilling.$inferSelect | undefined,
): BillingView {
  return {
    configured,
    hasCustomer: Boolean(row),
    plan: (row?.plan as Plan | null) ?? null,
    status: row?.status ?? null,
    trialEndsAt: row?.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    trialAvailable: !row?.trialUsed,
  };
}

const loadRow = async (db: DbOrTx, companyId: string) =>
  (await db.select().from(companyBilling).where(eq(companyBilling.companyId, companyId)))[0];

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
  return view(Boolean(gateway), row);
}

const localeSchema = z.enum(LOCALES).default("en");
const checkoutSchema = z.strictObject({ plan: z.enum(PLANS), locale: localeSchema });
const portalSchema = z.strictObject({ locale: localeSchema });

/**
 * Starts a Stripe Checkout for `plan` (billing.manage) and returns its URL. With the company's
 * trial still unused the checkout starts a TRIAL_DAYS trial without asking for a card. Billing not
 * configured → 409 billing.notConfigured; an existing live subscription → billing.alreadySubscribed
 * (changes go through the portal); the Stripe price missing → billing.priceMissing.
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
  const { plan, locale } = checkoutSchema.parse(input);
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

  const price = await gateway.findPrice(lookupKeyOf(plan));
  if (!price) throw new RecordStateError("billing.priceMissing");

  const page = `${appUrl.replace(/\/$/, "")}/${locale}/companies/${companyId}/billing`;
  const session = await gateway.createCheckoutSession({
    customerId: row.stripeCustomerId,
    priceId: price.id,
    companyId,
    successUrl: `${page}?checkout=success`,
    cancelUrl: `${page}?checkout=cancelled`,
    locale,
    trialDays: row.trialUsed ? null : TRIAL_DAYS,
  });
  await recordAudit(db, {
    companyId,
    actorUserId: actor.userId,
    action: "billing.checkoutStarted",
    entityType: "company",
    entityId: companyId,
    metadata: { plan, trial: !row.trialUsed },
  });
  return session;
}

/** A Stripe customer-portal session for managing the subscription (billing.manage). */
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
