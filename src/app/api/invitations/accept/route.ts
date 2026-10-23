import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";
import { acceptInvitation } from "@/server/tenancy/invitations-service";

export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ token: z.string().max(200) });

/**
 * Accepts an invitation for the signed-in user: `{ token }`. Unknown → 404; used, revoked or
 * expired → 409 invalid_state invitation.closed; another address → invitation.otherEmail; already
 * a member → invitation.alreadyMember.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return ok({ error: "invalid_request" }, 400);
    return ok(await acceptInvitation(db, user.userId, body.data.token));
  } catch (err) {
    return apiError(err);
  }
}
