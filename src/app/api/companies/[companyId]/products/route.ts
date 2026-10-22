import { headers } from "next/headers";
import { z } from "zod";
import { createProduct, listProducts } from "@/modules/products/server/product-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Products by name (products.view); `q` searches name, SKU and barcode; `includeArchived=1`. */
export async function GET(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const search = new URL(request.url).searchParams;
    return ok({
      products: await listProducts(db, toActor(user), id.data, {
        q: search.get("q") ?? undefined,
        includeArchived: search.get("includeArchived") === "1",
      }),
    });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Adds a product (products.manage): `{ name, kind?, sku?, description?, unit?, barcode?,
 * currency?, salePrice?, purchasePrice?, taxCategoryId?, trackStock? }`. Invalid → 422; an active
 * product with the same SKU → 409 sku_taken.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ product: await createProduct(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
