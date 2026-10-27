import { headers } from "next/headers";
import { z } from "zod";
import { voidPayment } from "@/modules/finance/server/payment-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; documentId: string; paymentId: string }> };
const pathSchema = z.object({ companyId: z.uuid(), documentId: z.uuid(), paymentId: z.uuid() });

/** Voids a payment (finance.manage): kept in the history, no longer counted → `{ payments }`. */
export async function DELETE(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, documentId, paymentId } = path.data;
    return ok({ payments: await voidPayment(db, toActor(user), companyId, documentId, paymentId) });
  } catch (err) {
    return apiError(err);
  }
}
