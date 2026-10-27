import "server-only";
import { z } from "zod";
import { listCounterparties } from "@/modules/counterparties/server/counterparty-service";
import {
  expenseQuerySchema,
  type ExpenseQuery,
  type ExpenseView,
  searchExpenses,
} from "@/modules/finance/server/expense-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type ExpensesPageData =
  | {
      status: "ok";
      query: ExpenseQuery;
      expenses: ExpenseView[];
      total: number;
      pageSize: number;
      canManage: boolean;
      /** Active suppliers for linking (suppliers.view only; otherwise free text). */
      suppliers: { id: string; name: string }[];
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Reads the list query from URL parameters; unknown or malformed values fall back to defaults. */
export function parseExpenseQuery(
  params: Record<string, string | string[] | undefined>,
): ExpenseQuery {
  const flat = Object.fromEntries(
    Object.entries(params)
      .map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
      .filter(([, v]) => typeof v === "string" && v !== ""),
  );
  const parsed = expenseQuerySchema.safeParse(flat);
  if (parsed.success) return parsed.data;
  // Keep the valid parts only.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    const one = expenseQuerySchema.safeParse({ [k]: v });
    if (one.success && k in one.data) out[k] = (one.data as Record<string, unknown>)[k];
  }
  return expenseQuerySchema.parse(out);
}

/** The expenses page (finance.view). `canManage` only decides the controls. */
export async function expensesPageData(
  user: AuthenticatedUser,
  companyId: string,
  query: ExpenseQuery,
): Promise<ExpensesPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const ctx = await requireCompanyAccess(db, actor, companyId, "finance.view");
    const page = await searchExpenses(db, actor, companyId, query);
    let suppliers: { id: string; name: string }[] = [];
    if (hasPermission(ctx, "suppliers.view"))
      suppliers = (await listCounterparties(db, actor, companyId, "supplier")).map((s) => ({
        id: s.id,
        name: s.name,
      }));
    return {
      status: "ok",
      query,
      expenses: page.expenses,
      total: page.total,
      pageSize: page.pageSize,
      canManage: hasPermission(ctx, "finance.manage"),
      suppliers,
    };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
