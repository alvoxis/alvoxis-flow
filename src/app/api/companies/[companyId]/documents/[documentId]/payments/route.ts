import { headers } from "next/headers";
import { z } from "zod";
import { invoicePayments, recordPayment } from "@/modules/finance/server/payment-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; documentId: string }> };
const pathSchema = z.object({ companyId: z.uuid(), documentId: z.uuid() });

/** Payments and derived status of an issued invoice (documents.view + finance.view). */
export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const view = await invoicePayments(
      db,
      toActor(user),
      path.data.companyId,
      path.data.documentId,
    );
    return ok({ payments: view });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Records a payment (finance.manage): `{ amount, paidOn, method, reference?, note? }` → 201
 * `{ payments }`. Above the open balance → 422; reference used before → 409 reference_taken.
 */
export async function POST(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const view = await recordPayment(
      db,
      toActor(user),
      path.data.companyId,
      path.data.documentId,
      body,
    );
    return ok({ payments: view }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
