import "server-only";
import { z } from "zod";
import {
  type BankAccountView,
  listBankAccounts,
} from "@/modules/documents/server/bank-account-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type BankAccountsPageData =
  | { status: "ok"; accounts: BankAccountView[]; canManage: boolean }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/**
 * Bank-accounts page (documents.view to read, archived ones included). `canManage`
 * (company.manage) only decides which controls are shown; the API enforces it.
 */
export async function bankAccountsPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<BankAccountsPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  try {
    const ctx = await requireCompanyAccess(db, toActor(user), companyId, "documents.view");
    const accounts = await listBankAccounts(db, toActor(user), companyId, {
      includeArchived: true,
    });
    return { status: "ok", accounts, canManage: hasPermission(ctx, "company.manage") };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    // Non-members, archived companies and missing permission look the same (no enumeration).
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
