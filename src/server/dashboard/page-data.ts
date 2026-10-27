import "server-only";
import { z } from "zod";
import { type DateRange } from "@/features/dashboard/range";
import {
  type BusinessDashboard,
  businessDashboard,
} from "@/modules/dashboard/server/business-dashboard";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import { listCompaniesForUser } from "@/server/tenancy/company-service";

export type BusinessDashboardPageData =
  | { status: "ok"; companyName: string; dashboard: BusinessDashboard }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** The business dashboard of one company (any member; sections by permission). */
export async function businessDashboardPageData(
  user: AuthenticatedUser,
  companyId: string,
  range: DateRange,
): Promise<BusinessDashboardPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  try {
    const dashboard = await businessDashboard(db, toActor(user), companyId, range);
    const company = (await listCompaniesForUser(db, user.userId)).find((c) => c.id === companyId);
    if (!company) return { status: "not_found" };
    return { status: "ok", companyName: company.name, dashboard };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
