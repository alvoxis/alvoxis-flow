import { headers } from "next/headers";
import { z } from "zod";
import { updateBankAccount } from "@/modules/documents/server/bank-account-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; accountId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), accountId: z.uuid() });

/**
 * Edits or archives/restores an account (company.manage):
 * `{ expectedVersion, label?, bankName?, bic?, isDefault?, archived? }`. The IBAN cannot change
 * (unknown fields → 422); stale version → 409; unknown account → 404. Issued documents keep the
 * details they were issued with.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, accountId } = path.data;
    return ok({
      bankAccount: await updateBankAccount(db, toActor(user), companyId, accountId, body),
    });
  } catch (err) {
    return invalidBody(err);
  }
}
