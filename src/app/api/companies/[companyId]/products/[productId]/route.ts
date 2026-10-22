import { headers } from "next/headers";
import { z } from "zod";
import { getProduct, updateProduct } from "@/modules/products/server/product-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; productId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), productId: z.uuid() });

/** One product (products.view); unknown → 404. */
export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, productId } = path.data;
    return ok({ product: await getProduct(db, toActor(user), companyId, productId) });
  } catch (err) {
    return apiError(err);
  }
}

/** Edits, archives or restores a product: `{ expectedVersion, archived?, …fields }`. */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, productId } = path.data;
    return ok({ product: await updateProduct(db, toActor(user), companyId, productId, body) });
  } catch (err) {
    return invalidBody(err);
  }
}
