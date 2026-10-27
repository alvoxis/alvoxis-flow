import "server-only";
import { z } from "zod";
import { type DateRange } from "@/features/dashboard/range";
import {
  availableReports,
  buildReport,
  type ReportId,
  type ReportTable,
} from "@/modules/reports/server/reports-service";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type ReportsPageData =
  | { status: "ok"; available: ReportId[]; current: ReportId | null; report: ReportTable | null }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** The reports page: the reports this role may open, and the chosen one (or the first). */
export async function reportsPageData(
  user: AuthenticatedUser,
  companyId: string,
  wanted: string | undefined,
  range: DateRange,
): Promise<ReportsPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const available = await availableReports(db, actor, companyId);
    const current = available.find((r) => r === wanted) ?? available[0] ?? null;
    const report = current ? await buildReport(db, actor, companyId, current, range) : null;
    return { status: "ok", available, current, report };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
