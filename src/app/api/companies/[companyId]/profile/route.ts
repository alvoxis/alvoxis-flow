import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";
import { getCompanyProfile, updateCompanyProfile } from "@/server/tenancy/company-profile";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Profile of one company: session → actor → requireCompanyAccess (company.view). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const id = z.uuid().parse((await params).companyId);
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok(await getCompanyProfile(db, toActor(user), id));
  } catch (err) {
    return apiError(err);
  }
}

/** Partial update (company.manage); invalid fields → 400 with per-field error codes. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const id = z.uuid().parse((await params).companyId);
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const result = await updateCompanyProfile(db, toActor(user), id, body);
    return result.ok
      ? ok({ profile: result.profile })
      : ok({ error: "invalid_request", fieldErrors: result.fieldErrors }, 400);
  } catch (err) {
    return apiError(err);
  }
}
