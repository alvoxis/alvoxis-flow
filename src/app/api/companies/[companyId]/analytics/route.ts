import { headers } from "next/headers";
import { z } from "zod";
import { companyAnalytics } from "@/modules/analytics/server/analytics-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Figures of one year (analytics.view + documents.view): `?year=YYYY`. */
export async function GET(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  const year = z.coerce
    .number()
    .int()
    .min(2000)
    .max(2100)
    .safeParse(new URL(request.url).searchParams.get("year") ?? new Date().getUTCFullYear());
  if (!id.success || !year.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ analytics: await companyAnalytics(db, toActor(user), id.data, year.data) });
  } catch (err) {
    return apiError(err);
  }
}
