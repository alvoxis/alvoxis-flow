import { headers } from "next/headers";
import { z } from "zod";
import { parseRange } from "@/features/dashboard/range";
import { buildReport, REPORTS } from "@/modules/reports/server/reports-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { csvResponse, csvText, toCsv } from "@/server/http/csv";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; report: string }> };
const pathSchema = z.object({ companyId: z.uuid(), report: z.enum(REPORTS) });

/**
 * One report for `?range=…&from=…&to=…` (default: this year) → `{ report }`, or a CSV download
 * with `format=csv`. Each report checks its own permissions.
 */
export async function GET(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const q = Object.fromEntries(new URL(request.url).searchParams);
    const range = parseRange(
      { range: q.range ?? "this_year", from: q.from, to: q.to },
      new Date().toISOString().slice(0, 10),
    );
    const report = await buildReport(
      db,
      toActor(user),
      path.data.companyId,
      path.data.report,
      range,
    );
    if (q.format !== "csv") return ok({ report, range });
    const numeric = new Set(report.numeric);
    const cells = (row: string[]) =>
      row.map((v, i) => (numeric.has(report.columns[i]!) ? v : csvText(v)));
    return csvResponse(
      `${report.id}-${range.from}-${range.to}.csv`,
      toCsv(report.columns, [...report.rows, ...report.totals].map(cells)),
    );
  } catch (err) {
    return apiError(err);
  }
}
