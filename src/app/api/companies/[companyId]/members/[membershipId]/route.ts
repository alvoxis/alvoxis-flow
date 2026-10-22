import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";
import { updateMember } from "@/server/tenancy/members-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; membershipId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), membershipId: z.uuid() });

/**
 * Changes a member's role or status (members.manage): `{ roleKey?, status?: active|suspended }`.
 * Own membership or owner changes by a non-owner → 403; the last owner → 409.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, membershipId } = path.data;
    return ok({ member: await updateMember(db, toActor(user), companyId, membershipId, body) });
  } catch (err) {
    return invalidBody(err);
  }
}
