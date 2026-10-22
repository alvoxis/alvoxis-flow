import "server-only";
import { z } from "zod";
import {
  listTaxCategories,
  type TaxCategoryView,
} from "@/modules/documents/server/tax-category-service";
import { listProducts, type ProductView } from "@/modules/products/server/product-service";
import { type Actor, hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type ProductsPageData =
  | {
      status: "ok";
      items: ProductView[];
      /** Active categories offered as a product's default. */
      categories: TaxCategoryView[];
      /** Names of all categories, archived included, by id. */
      categoryNames: Record<string, string>;
      canManage: boolean;
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Tax categories need documents.view; roles without it (production) see products without them. */
async function categoriesIfAllowed(actor: Actor, companyId: string) {
  try {
    return await listTaxCategories(getDb(), actor, companyId, { includeArchived: true });
  } catch (err) {
    if (err instanceof ForbiddenError) return [];
    throw err;
  }
}

/** Products page (products.view; archived included). `canManage` only decides the controls. */
export async function productsPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<ProductsPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const ctx = await requireCompanyAccess(db, actor, companyId, "products.view");
    const [items, all] = await Promise.all([
      listProducts(db, actor, companyId, { includeArchived: true }),
      categoriesIfAllowed(actor, companyId),
    ]);
    return {
      status: "ok",
      items,
      categories: all.filter((c) => !c.archived),
      categoryNames: Object.fromEntries(all.map((c) => [c.id, `${c.code} · ${c.label}`])),
      canManage: hasPermission(ctx, "products.manage"),
    };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
