import { headers } from "next/headers";
import { z } from "zod";
import { createCalculation, listCalculations } from "@/modules/costing/server/costing-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Saved cost calculations, newest first (products.view) → `{ calculations }`. */
export async function GET(_request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ calculations: await listCalculations(db, toActor(user), id.data) });
  } catch (err) {
    return apiError(err);
  }
}

/** Saves a calculation (products.manage): `{ name, productId?, calculation }` → 201. */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ calculation: await createCalculation(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
