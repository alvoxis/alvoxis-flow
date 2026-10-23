import "server-only";
import { z } from "zod";
import { type AnalyticsView, companyAnalytics } from "@/modules/analytics/server/analytics-service";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type AnalyticsPageData =
  | { status: "ok"; data: AnalyticsView }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Analytics page for one year (analytics.view + documents.view); a bad year → current year. */
export async function analyticsPageData(
  user: AuthenticatedUser,
  companyId: string,
  yearParam: string | undefined,
): Promise<AnalyticsPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const current = new Date().getUTCFullYear();
  const parsed = z.coerce.number().int().min(2000).max(2100).safeParse(yearParam);
  const year = parsed.success ? parsed.data : current;
  try {
    return { status: "ok", data: await companyAnalytics(getDb(), toActor(user), companyId, year) };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
