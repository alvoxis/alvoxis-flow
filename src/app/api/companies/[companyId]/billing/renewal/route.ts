import { headers } from "next/headers";
import { z } from "zod";
import { setRenewal } from "@/modules/billing/server/billing-service";
import { getStripeGateway } from "@/modules/billing/server/gateway";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/**
 * Cancels the renewal at period end (`{ cancel: true }`) or resumes it (`{ cancel: false }`)
 * (billing.manage) → `{ billing }`. No live subscription → 409 invalid_state billing.noSubscription.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const billing = await setRenewal(db, getStripeGateway(), toActor(user), id.data, body);
    return ok({ billing });
  } catch (err) {
    return invalidBody(err);
  }
}
