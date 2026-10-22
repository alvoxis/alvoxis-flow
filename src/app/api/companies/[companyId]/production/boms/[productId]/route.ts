import { headers } from "next/headers";
import { z } from "zod";
import { setBillOfMaterials } from "@/modules/production/server/production-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; productId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), productId: z.uuid() });

/**
 * Replaces a product's bill of materials (production.manage):
 * `{ components: [{ componentId, quantity }] }` per one unit of the product; `[]` removes it.
 */
export async function PUT(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, productId } = path.data;
    return ok({ bom: await setBillOfMaterials(db, toActor(user), companyId, productId, body) });
  } catch (err) {
    return invalidBody(err);
  }
}
