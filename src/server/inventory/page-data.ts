import "server-only";
import { z } from "zod";
import {
  listMovements,
  listWarehouses,
  type MovementView,
  productNames,
  stockLevels,
  type StockLevelView,
  type WarehouseView,
} from "@/modules/inventory/server/inventory-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type InventoryPageData =
  | {
      status: "ok";
      warehouses: WarehouseView[];
      stock: StockLevelView[];
      movements: MovementView[];
      productNames: Record<string, string>;
      canManage: boolean;
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Inventory page (inventory.view): warehouses, stock, the latest 100 movements. */
export async function inventoryPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<InventoryPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const ctx = await requireCompanyAccess(db, actor, companyId, "inventory.view");
    const [warehouses, stock, movements] = await Promise.all([
      listWarehouses(db, actor, companyId, { includeArchived: true }),
      stockLevels(db, actor, companyId),
      listMovements(db, actor, companyId, { limit: 100 }),
    ]);
    const known = new Set(stock.map((s) => s.productId));
    const names = {
      ...Object.fromEntries(stock.map((s) => [s.productId, s.name])),
      ...(await productNames(
        db,
        actor,
        companyId,
        movements.map((m) => m.productId).filter((id) => !known.has(id)),
      )),
    };
    return {
      status: "ok",
      warehouses,
      stock,
      movements,
      productNames: names,
      canManage: hasPermission(ctx, "inventory.manage"),
    };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
