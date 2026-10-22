import { headers } from "next/headers";
import { z } from "zod";
import { listMovements } from "@/modules/inventory/server/inventory-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

const querySchema = z.object({
  productId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Latest stock movements, newest first (inventory.view); filters: productId, warehouseId. */
export async function GET(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  const query = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!id.success || !query.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ movements: await listMovements(db, toActor(user), id.data, query.data) });
  } catch (err) {
    return apiError(err);
  }
}
