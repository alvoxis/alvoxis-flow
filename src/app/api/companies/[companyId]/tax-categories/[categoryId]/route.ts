import { headers } from "next/headers";
import { z } from "zod";
import { updateTaxCategory } from "@/modules/documents/server/tax-category-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; categoryId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), categoryId: z.uuid() });

/**
 * Edits label/note or archives/restores a category (tax_categories.manage):
 * `{ expectedVersion, label?, note?, archived? }`. code, kind and ratePercent cannot change
 * (unknown fields → 422); stale version → 409; unknown category → 404.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, categoryId } = path.data;
    return ok(await updateTaxCategory(db, toActor(user), companyId, categoryId, body));
  } catch (err) {
    return invalidBody(err);
  }
}
