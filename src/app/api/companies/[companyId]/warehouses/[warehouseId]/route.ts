import { headers } from "next/headers";
import { z } from "zod";
import { updateWarehouse } from "@/modules/inventory/server/inventory-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; warehouseId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), warehouseId: z.uuid() });

/**
 * Renames, makes default, archives or restores a warehouse (inventory.manage):
 * `{ expectedVersion, name?, isDefault?, archived? }`. Holding stock → 409 warehouse.notEmpty.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, warehouseId } = path.data;
    return ok({
      warehouse: await updateWarehouse(db, toActor(user), companyId, warehouseId, body),
    });
  } catch (err) {
    return invalidBody(err);
  }
}
