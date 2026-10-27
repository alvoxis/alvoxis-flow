import "server-only";
import { z } from "zod";
import {
  billingInvoices,
  type BillingInvoiceView,
  billingOverview,
  type BillingView,
} from "@/modules/billing/server/billing-service";
import { getStripeGateway } from "@/modules/billing/server/gateway";
import { requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type BillingPageData =
  | { status: "ok"; billing: BillingView; invoices: BillingInvoiceView[] | null }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/**
 * The billing page (billing.manage): the subscription refreshed from Stripe and the billing
 * history. Invoices are null when Stripe did not answer (the page says so instead of failing).
 */
export async function billingPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<BillingPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const gateway = getStripeGateway();
  const actor = toActor(user);
  try {
    const billing = await billingOverview(db, gateway, actor, companyId);
    const invoices = await billingInvoices(db, gateway, actor, companyId).catch((err: unknown) => {
      if (err instanceof ForbiddenError) throw err;
      console.error(`[billing] loading invoices failed: ${(err as Error).name}`);
      return null;
    });
    return { status: "ok", billing, invoices };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}

export interface SubscriptionBanner {
  kind: "read_only" | "past_due";
  canManageBilling: boolean;
}

/**
 * The subscription banner shown on every page of a company (null when there is nothing to say,
 * subscriptions are not enforced, or the user has no access — the page itself handles that).
 * Reads the cached Stripe state only; it never calls Stripe.
 */
export async function subscriptionBanner(
  user: AuthenticatedUser,
  companyId: string,
): Promise<SubscriptionBanner | null> {
  if (!z.uuid().safeParse(companyId).success) return null;
  try {
    const ctx = await requireCompanyAccess(getDb(), toActor(user), companyId);
    if (!ctx.subscription.enforced) return null;
    const canManageBilling = ctx.permissions.has("billing.manage");
    if (ctx.subscription.access === "read_only") return { kind: "read_only", canManageBilling };
    if (ctx.subscription.phase === "past_due") return { kind: "past_due", canManageBilling };
    return null;
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof TwoFactorRequiredError) return null;
    throw err;
  }
}
