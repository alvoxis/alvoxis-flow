import "server-only";
import { z } from "zod";
import { type DocumentsOverview, summarizeDocuments } from "@/features/dashboard/summary";
import { listDocuments } from "@/modules/documents/server/document-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { getMailer } from "@/server/auth/instance";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { listMySessions } from "@/server/auth/sessions-service";
import { userRequiresTwoFactor } from "@/server/auth/two-factor-policy";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import { type CompanyProfileView, getCompanyProfile } from "@/server/tenancy/company-profile";
import { listCompaniesForUser } from "@/server/tenancy/company-service";

/** Data loaders for account/dashboard pages (keeps database access out of UI files). */
/**
 * A company's document figures on the dashboard: real figures (`ok`, possibly all zero), no access
 * for this user's role or session (`no_access`), or not loadable right now (`error`). The three
 * are shown differently, so an outage never looks like an empty company.
 */
export type DashboardDocuments =
  | { status: "ok"; overview: DocumentsOverview; canCreate: boolean }
  | { status: "no_access" }
  | { status: "error" };

export async function dashboardData(user: AuthenticatedUser) {
  const db = getDb();
  const [companies, needsTwoFactor] = await Promise.all([
    listCompaniesForUser(db, user.userId),
    userRequiresTwoFactor(db, user.userId),
  ]);
  // Real document figures per company, through the same access check as the documents page
  // (requireCompanyAccess + documents.view).
  const documents = new Map<string, DashboardDocuments>();
  for (const c of companies) {
    try {
      const actor = toActor(user);
      const ctx = await requireCompanyAccess(db, actor, c.id, "documents.view");
      const overview = summarizeDocuments(await listDocuments(db, actor, c.id));
      documents.set(c.id, {
        status: "ok",
        overview,
        canCreate: hasPermission(ctx, "documents.create"),
      });
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof TwoFactorRequiredError) {
        documents.set(c.id, { status: "no_access" });
      } else {
        // The rest of the dashboard stays usable; only the error class is logged, never data.
        console.error("[dashboard] document figures could not be loaded", errName(err));
        documents.set(c.id, { status: "error" });
      }
    }
  }
  return {
    companies: companies.map((c) => ({
      ...c,
      documents: documents.get(c.id) ?? ({ status: "error" } as const),
    })),
    twoFactorMissing: needsTwoFactor && !user.twoFactorVerified,
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Companies the user belongs to, for the "Documents" entry in the main navigation. */
export async function documentsEntryData(user: AuthenticatedUser) {
  return listCompaniesForUser(getDb(), user.userId);
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
