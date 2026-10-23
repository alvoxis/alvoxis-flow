import { headers } from "next/headers";
import { z } from "zod";
import { changeProductionOrder } from "@/modules/production/server/production-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; orderId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), orderId: z.uuid() });

/**
 * Completes or cancels a planned order (production.manage):
 * `{ action: "complete", expectedVersion, completedOn }` or `{ action: "cancel", expectedVersion }`.
 * Short stock → 422 with issues; not planned → 409 invalid_state.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, orderId } = path.data;
    return ok({ order: await changeProductionOrder(db, toActor(user), companyId, orderId, body) });
  } catch (err) {
    return invalidBody(err);
  }
}
