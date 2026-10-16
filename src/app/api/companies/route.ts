import { headers } from "next/headers";
import { z } from "zod";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";

export const dynamic = "force-dynamic";

const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  country: z.enum(["LV", "LT", "EE", "PL"]),
});

/** Creates a company with the caller as owner (who must then enrol in 2FA to use it). */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const input = createCompanySchema.parse(await request.json());
    const actor = toActor(user);
    const { companyId } = await createCompanyWithOwner(db, actor, input);
    // Owner role requires 2FA: default numbering series are created once access is possible.
    if (actor.twoFactorVerified) await ensureDefaultNumberSeries(db, actor, companyId);
    return ok({ companyId }, 201);
  } catch (err) {
    return apiError(err);
  }
}
