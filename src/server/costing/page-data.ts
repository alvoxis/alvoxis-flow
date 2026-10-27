import "server-only";
import { z } from "zod";
import {
  type CostCalculationView,
  listCalculations,
} from "@/modules/costing/server/costing-service";
import { listProducts } from "@/modules/products/server/product-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type CostingPageData =
  | {
      status: "ok";
      saved: CostCalculationView[];
      products: { id: string; name: string }[];
      canManage: boolean;
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** The cost calculator page (products.view; saving needs products.manage). */
export async function costingPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<CostingPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const ctx = await requireCompanyAccess(db, actor, companyId, "products.view");
    const [saved, items] = await Promise.all([
      listCalculations(db, actor, companyId),
      listProducts(db, actor, companyId),
    ]);
    return {
      status: "ok",
      saved,
      products: items.map((p) => ({ id: p.id, name: p.name })),
      canManage: hasPermission(ctx, "products.manage"),
    };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
