import { headers } from "next/headers";
import { z } from "zod";
import { billingInvoices } from "@/modules/billing/server/billing-service";
import { getStripeGateway } from "@/modules/billing/server/gateway";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** The company's Stripe invoices, newest first (billing.manage) → `{ invoices }`. */
export async function GET(_request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ invoices: await billingInvoices(db, getStripeGateway(), toActor(user), id.data) });
  } catch (err) {
    return apiError(err);
  }
}
