import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";
import { revokeInvitation } from "@/server/tenancy/invitations-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; invitationId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), invitationId: z.uuid() });

/** Revokes an open invitation (members.manage); its link stops working. */
export async function DELETE(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    await revokeInvitation(db, toActor(user), path.data.companyId, path.data.invitationId);
    return ok({ revoked: true });
  } catch (err) {
    return apiError(err);
  }
}
