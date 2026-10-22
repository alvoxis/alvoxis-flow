import { headers } from "next/headers";
import { z } from "zod";
import {
  createProductionOrder,
  listProductionOrders,
} from "@/modules/production/server/production-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Production orders, planned first (production.view). */
export async function GET(_request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ orders: await listProductionOrders(db, toActor(user), id.data) });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Plans an order (production.manage): `{ productId, warehouseId, quantity, plannedOn, note? }`.
 * The product needs a bill of materials; components are copied into the order.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ order: await createProductionOrder(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
