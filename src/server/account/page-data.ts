import "server-only";
import { getMailer } from "@/server/auth/instance";
import { type AuthenticatedUser } from "@/server/auth/session";
import { listMySessions } from "@/server/auth/sessions-service";
import { userRequiresTwoFactor } from "@/server/auth/two-factor-policy";
import { getDb } from "@/server/db/client";
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
