import { headers } from "next/headers";
import { z } from "zod";
import { recordStockOperation } from "@/modules/inventory/server/inventory-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/**
 * Records a stock operation (inventory.manage): `{ kind: receipt|issue|transfer|count, productId,
 * warehouseId, toWarehouseId?, quantity, unitCost?, occurredOn, reference?, note? }`. Returns the
 * written movements (none for a count that matches the balance). A balance below zero, an
 * untracked product or an archived warehouse → 422 with issues.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ movements: await recordStockOperation(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
