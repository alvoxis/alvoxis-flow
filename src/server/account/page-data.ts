import "server-only";
import { getMailer } from "@/server/auth/instance";
import { z } from "zod";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { listMySessions } from "@/server/auth/sessions-service";
import { userRequiresTwoFactor } from "@/server/auth/two-factor-policy";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import { type CompanyProfileView, getCompanyProfile } from "@/server/tenancy/company-profile";
import { listCompaniesForUser } from "@/server/tenancy/company-service";

/** Data loaders for account/dashboard pages (keeps database access out of UI files). */
export async function dashboardData(user: AuthenticatedUser) {
  const db = getDb();
  const [companies, needsTwoFactor] = await Promise.all([
    listCompaniesForUser(db, user.userId),
    userRequiresTwoFactor(db, user.userId),
  ]);
  return { companies, twoFactorMissing: needsTwoFactor && !user.twoFactorVerified };
}

export async function securityData(user: AuthenticatedUser) {
  const db = getDb();
  const [sessions, requiredForRole] = await Promise.all([
    listMySessions(db, user),
    userRequiresTwoFactor(db, user.userId),
  ]);
  return { sessions, requiredForRole, emailConfigured: getMailer().configured };
}

export async function twoFactorRequiredForRole(user: AuthenticatedUser) {
  return userRequiresTwoFactor(getDb(), user.userId);
}

export type CompanyProfilePageData =
  | { status: "ok"; view: CompanyProfileView }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Profile page: access is decided by requireCompanyAccess inside getCompanyProfile. */
export async function companyProfileData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<CompanyProfilePageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  try {
    return { status: "ok", view: await getCompanyProfile(getDb(), toActor(user), companyId) };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    // Non-members and missing companies look the same (no tenant enumeration).
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
