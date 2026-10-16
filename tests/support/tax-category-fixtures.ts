import { createTaxCategory } from "@/modules/documents/server/tax-category-service";
import { type DocumentLine, type TaxCategorySnapshot } from "@/modules/documents/domain";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { FIXTURE_TAX } from "./document-fixtures";

/** Category id per fixture code (FIXTURE_TAX values are arbitrary, not real country rates). */
export type FixtureCategoryIds = Record<string, string>;

/** Adds categories (default: every FIXTURE_TAX one) to the company catalog (needs tax_categories.manage). */
export async function addFixtureTaxCategories(
  db: Database,
  actor: Actor,
  companyId: string,
  categories: readonly TaxCategorySnapshot[] = Object.values(FIXTURE_TAX),
): Promise<FixtureCategoryIds> {
  const ids: FixtureCategoryIds = {};
  for (const cat of new Map(categories.map((c) => [c.code, c])).values()) {
    ids[cat.code] = (await createTaxCategory(db, actor, companyId, cat)).taxCategory.id;
  }
  return ids;
}

/** Domain lines with snapshots → API input lines that reference the catalog by id. */
export function withCategoryIds<L extends Pick<DocumentLine, "taxCategory">>(
  lines: L[],
  ids: FixtureCategoryIds,
) {
  return lines.map(({ taxCategory, ...l }) => {
    if (taxCategory && !ids[taxCategory.code])
      throw new Error(`No fixture category ${taxCategory.code}`);
    return { ...l, taxCategoryId: taxCategory ? ids[taxCategory.code]! : null };
  });
}
