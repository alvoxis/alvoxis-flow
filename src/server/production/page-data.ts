import "server-only";
import { z } from "zod";
import {
  type BillOfMaterialsView,
  listBillsOfMaterials,
  listProductionOrders,
  productionCatalog,
  type ProductionCatalog,
  type ProductionOrderView,
} from "@/modules/production/server/production-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type ProductionPageData =
  | {
      status: "ok";
      orders: ProductionOrderView[];
      boms: BillOfMaterialsView[];
      catalog: ProductionCatalog;
      canManage: boolean;
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Production page (production.view): orders, bills of materials and what planning needs. */
export async function productionPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<ProductionPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const ctx = await requireCompanyAccess(db, actor, companyId, "production.view");
    const [orders, boms, catalog] = await Promise.all([
      listProductionOrders(db, actor, companyId),
      listBillsOfMaterials(db, actor, companyId),
      productionCatalog(db, actor, companyId),
    ]);
    return {
      status: "ok",
      orders,
      boms,
      catalog,
      canManage: hasPermission(ctx, "production.manage"),
    };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
