import { headers } from "next/headers";
import { z } from "zod";
import { getServerEnv } from "@/config/env";
import { openPortal } from "@/modules/billing/server/billing-service";
import { getStripeGateway } from "@/modules/billing/server/gateway";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/**
 * Opens the Stripe customer portal (billing.manage): `{ locale? }` → `{ url }`. Not configured or
 * no customer yet → 409 invalid_state with a code.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const session = await openPortal(
      db,
      getStripeGateway(),
      getServerEnv().APP_URL,
      toActor(user),
      id.data,
      body,
    );
    return ok(session);
  } catch (err) {
    return invalidBody(err);
  }
}
