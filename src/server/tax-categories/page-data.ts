import "server-only";
import { z } from "zod";
import {
  listTaxCategories,
  type TaxCategoryView,
} from "@/modules/documents/server/tax-category-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type TaxCategoriesPageData =
  | { status: "ok"; categories: TaxCategoryView[]; canManage: boolean }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/**
 * Tax-category catalog page (documents.view to read, archived ones included). `canManage`
 * (tax_categories.manage) only decides which controls are shown; the API enforces it.
 */
export async function taxCategoriesPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<TaxCategoriesPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  try {
    const ctx = await requireCompanyAccess(db, toActor(user), companyId, "documents.view");
    const categories = await listTaxCategories(db, toActor(user), companyId, {
      includeArchived: true,
    });
    return { status: "ok", categories, canManage: hasPermission(ctx, "tax_categories.manage") };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    // Non-members, archived companies and missing permission look the same (no enumeration).
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
