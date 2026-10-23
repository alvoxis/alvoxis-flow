import "server-only";
import { z } from "zod";
import {
  type EmployeeView,
  getPayrollRates,
  listEmployees,
  listPayrollRuns,
  type PayrollRunView,
  type RatesView,
} from "@/modules/payroll/server/payroll-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type PayrollPageData =
  | {
      status: "ok";
      employees: EmployeeView[];
      runs: PayrollRunView[];
      rates: RatesView[];
      canManage: boolean;
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Payroll page (payroll.view): employees, runs and rates. */
export async function payrollPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<PayrollPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const ctx = await requireCompanyAccess(db, actor, companyId, "payroll.view");
    const [employees, runs, rates] = await Promise.all([
      listEmployees(db, actor, companyId, { includeArchived: true }),
      listPayrollRuns(db, actor, companyId),
      getPayrollRates(db, actor, companyId),
    ]);
    return {
      status: "ok",
      employees,
      runs,
      rates,
      canManage: hasPermission(ctx, "payroll.manage"),
    };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
