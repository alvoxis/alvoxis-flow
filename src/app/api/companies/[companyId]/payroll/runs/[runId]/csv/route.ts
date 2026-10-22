import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { payrollRunCsv } from "@/modules/payroll/server/payroll-service";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; runId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), runId: z.uuid() });

/** The run as a CSV download (payroll.view). Never cached. */
export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const csv = await payrollRunCsv(db, toActor(user), path.data.companyId, path.data.runId);
    return new Response(csv.body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${csv.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
