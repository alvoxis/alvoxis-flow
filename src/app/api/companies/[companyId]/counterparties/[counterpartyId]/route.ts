import { headers } from "next/headers";
import { z } from "zod";
import {
  getCounterparty,
  updateCounterparty,
} from "@/modules/counterparties/server/counterparty-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; counterpartyId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), counterpartyId: z.uuid() });

/** One customer/supplier (the view permission of one of its roles); otherwise 404. */
export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, counterpartyId } = path.data;
    return ok({
      counterparty: await getCounterparty(db, toActor(user), companyId, counterpartyId),
    });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Edits, archives or restores a record: `{ expectedVersion, archived?, …fields }` (the manage
 * permission of every role it has before and after). Stale version → 409; unknown → 404.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, counterpartyId } = path.data;
    return ok({
      counterparty: await updateCounterparty(db, toActor(user), companyId, counterpartyId, body),
    });
  } catch (err) {
    return invalidBody(err);
  }
}
