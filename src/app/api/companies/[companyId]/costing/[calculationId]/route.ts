import { headers } from "next/headers";
import { z } from "zod";
import {
  deleteCalculation,
  getCalculation,
  updateCalculation,
} from "@/modules/costing/server/costing-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; calculationId: string }> };
const pathSchema = z.object({ companyId: z.uuid(), calculationId: z.uuid() });

export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, calculationId } = path.data;
    return ok({ calculation: await getCalculation(db, toActor(user), companyId, calculationId) });
  } catch (err) {
    return apiError(err);
  }
}

/** Replaces a calculation (products.manage, `expectedVersion`) → `{ calculation }`. */
export async function PUT(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, calculationId } = path.data;
    return ok({
      calculation: await updateCalculation(db, toActor(user), companyId, calculationId, body),
    });
  } catch (err) {
    return invalidBody(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    await deleteCalculation(db, toActor(user), path.data.companyId, path.data.calculationId);
    return ok({ deleted: true });
  } catch (err) {
    return apiError(err);
  }
}
