import "server-only";
import { z } from "zod";
import { billingOverview, type BillingView } from "@/modules/billing/server/billing-service";
import { getStripeGateway } from "@/modules/billing/server/gateway";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type BillingPageData =
  | { status: "ok"; billing: BillingView }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** The billing page (billing.manage): the subscription, refreshed from Stripe. */
export async function billingPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<BillingPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  try {
    const billing = await billingOverview(getDb(), getStripeGateway(), toActor(user), companyId);
    return { status: "ok", billing };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
