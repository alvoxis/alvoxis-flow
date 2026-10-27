import { headers } from "next/headers";
import { z } from "zod";
import { grantInternalAccess, revokeInternalAccess } from "@/modules/admin/server/admin-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Platform admins: `{ days (1–90), reason }` → internal access without a subscription. Audited. */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ grant: await grantInternalAccess(db, toActor(user), id.data, body) });
  } catch (err) {
    return invalidBody(err);
  }
}

/** Platform admins: removes the grant. Audited. */
export async function DELETE(_request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    await revokeInternalAccess(db, toActor(user), id.data);
    return ok({ revoked: true });
  } catch (err) {
    return apiError(err);
  }
}
