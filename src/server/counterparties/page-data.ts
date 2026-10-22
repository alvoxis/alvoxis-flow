import "server-only";
import { z } from "zod";
import {
  type CounterpartyKind,
  type CounterpartyView,
  listCounterparties,
} from "@/modules/counterparties/server/counterparty-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type CounterpartiesPageData =
  | {
      status: "ok";
      items: CounterpartyView[];
      canManage: boolean;
      canViewDocuments: boolean;
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/**
 * Customers or suppliers page (customers.view / suppliers.view; archived records included).
 * `canManage` and `canViewDocuments` only decide which controls are shown; the API enforces them.
 */
export async function counterpartiesPageData(
  user: AuthenticatedUser,
  companyId: string,
  kind: CounterpartyKind,
): Promise<CounterpartiesPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const ctx = await requireCompanyAccess(
      db,
      actor,
      companyId,
      kind === "customer" ? "customers.view" : "suppliers.view",
    );
    const items = await listCounterparties(db, actor, companyId, kind, { includeArchived: true });
    return {
      status: "ok",
      items,
      canManage: hasPermission(ctx, kind === "customer" ? "customers.manage" : "suppliers.manage"),
      canViewDocuments: hasPermission(ctx, "documents.view"),
    };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    // Non-members, archived companies and missing permission look the same (no enumeration).
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
