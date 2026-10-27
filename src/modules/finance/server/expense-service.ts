import "server-only";
import { and, asc, desc, eq, gte, ilike, lte, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type CurrencyCode, Money } from "@/lib/money";
import { type ValidationIssue } from "@/modules/documents/domain/validation";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { counterparties, expenses } from "@/server/db/schema";
import {
  RecordNotFoundError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";
import {
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  expenseCost,
  expenseGross,
  PAYMENT_METHODS,
  type PaymentMethod,
  type Recurrence,
  RECURRENCES,
} from "../domain/expenses";
import { isIsoDate } from "../domain/receivables";
import { todayIso } from "./payment-service";

/**
 * Company expenses (finance.view to read and export, finance.manage to add, change and delete).
 * Entered by hand; every row says so (`source` = manual). Deleting asks for confirmation in the UI
 * and is audited (field names only, never amounts or descriptions).
 */

type Row = typeof expenses.$inferSelect;

export interface ExpenseView {
  id: string;
  expenseDate: string;
  category: ExpenseCategory;
  description: string;
  supplierId: string | null;
  supplierName: string | null;
  currency: CurrencyCode;
  netAmount: string;
  taxAmount: string;
  taxRecoverable: boolean;
  grossAmount: string;
  /** The amount that counts as cost (net, plus tax when it is not recoverable). */
  costAmount: string;
  status: "paid" | "unpaid";
  dueDate: string | null;
  paidOn: string | null;
  paymentMethod: PaymentMethod | null;
  reference: string | null;
  notes: string | null;
  recurrence: Recurrence;
  source: string;
  overdue: boolean;
  version: number;
}

const toView = (r: Row, linkedSupplier: string | null = null): ExpenseView => {
  const amounts = {
    currency: r.currency,
    netAmount: r.netAmount,
    taxAmount: r.taxAmount,
    taxRecoverable: r.taxRecoverable,
  };
  return {
    id: r.id,
    expenseDate: r.expenseDate,
    category: r.category as ExpenseCategory,
    description: r.description,
    supplierId: r.supplierId,
    supplierName: linkedSupplier ?? r.supplierName,
    currency: r.currency,
    netAmount: Money.of(r.netAmount, r.currency).toFixed(),
    taxAmount: Money.of(r.taxAmount, r.currency).toFixed(),
    taxRecoverable: r.taxRecoverable,
    grossAmount: expenseGross(amounts),
    costAmount: expenseCost(amounts),
    status: r.status,
    dueDate: r.dueDate,
    paidOn: r.paidOn,
    paymentMethod: r.paymentMethod,
    reference: r.reference,
    notes: r.notes,
    recurrence: r.recurrence,
    source: r.source,
    overdue: r.status === "unpaid" && r.dueDate !== null && r.dueDate < todayIso(),
    version: r.version,
  };
};

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional();
const optDate = z
  .string()
  .max(10)
  .transform((v) => v.trim() || null)
  .nullable()
  .optional();

const fields = {
  expenseDate: z.string().max(10),
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().max(300),
  supplierId: z.uuid().nullable().optional(),
  supplierName: optText(200),
  currency: z.enum(["EUR", "PLN"]),
  netAmount: z.string().max(24),
  taxAmount: z.string().max(24).optional(),
  taxRecoverable: z.boolean().optional(),
  status: z.enum(["paid", "unpaid"]),
  dueDate: optDate,
  paidOn: optDate,
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  reference: optText(100),
  notes: optText(2000),
  recurrence: z.enum(RECURRENCES).optional(),
};
const createSchema = z.strictObject(fields);
const updateSchema = z.strictObject({ ...fields, expectedVersion: z.number().int().positive() });

const AMOUNT = /^\d{1,14}(\.\d{1,2})?$/;
const validDate = isIsoDate;

type Values = Omit<
  typeof expenses.$inferInsert,
  "id" | "companyId" | "createdByUserId" | "createdAt" | "updatedAt" | "version" | "source"
>;

async function validate(
  tx: DbOrTx,
  companyId: string,
  d: z.infer<typeof createSchema>,
): Promise<Values> {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
  const amount = (v: string | undefined, path: string) => {
    const s = (v ?? "0").trim().replace(",", ".") || "0";
    if (!AMOUNT.test(s)) {
      add("expense.amount.invalid", path);
      return "0";
    }
    return s;
  };
  const description = d.description.trim();
  if (!description) add("expense.description.required", "description");
  if (!validDate(d.expenseDate)) add("expense.date.invalid", "expenseDate");
  const netAmount = amount(d.netAmount, "netAmount");
  const taxAmount = amount(d.taxAmount, "taxAmount");
  const dueDate = d.dueDate ?? null;
  if (dueDate && !validDate(dueDate)) add("expense.dueDate.invalid", "dueDate");
  // Paid without a date: paid on the expense date (when that date itself is valid).
  let paidOn =
    d.status === "paid" ? (d.paidOn ?? (validDate(d.expenseDate) ? d.expenseDate : null)) : null;
  if (d.status === "paid" && paidOn && !validDate(paidOn)) {
    add("expense.paidOn.invalid", "paidOn");
    paidOn = null;
  }
  if (d.supplierId) {
    const [s] = await tx
      .select({ isSupplier: counterparties.isSupplier })
      .from(counterparties)
      .where(and(eq(counterparties.id, d.supplierId), eq(counterparties.companyId, companyId)));
    if (!s || !s.isSupplier) add("expense.supplier.unknown", "supplierId");
  }
  if (issues.length) throw new RecordValidationError(issues);
  return {
    expenseDate: d.expenseDate,
    category: d.category,
    description,
    supplierId: d.supplierId ?? null,
    supplierName: d.supplierId ? null : (d.supplierName ?? null),
    currency: d.currency,
    netAmount,
    taxAmount,
    taxRecoverable: d.taxRecoverable ?? true,
    status: d.status,
    dueDate,
    paidOn,
    paymentMethod: d.paymentMethod ?? null,
    reference: d.reference ?? null,
    notes: d.notes ?? null,
    recurrence: d.recurrence ?? "none",
  };
}

async function supplierName(tx: DbOrTx, companyId: string, id: string | null) {
  if (!id) return null;
  const [s] = await tx
    .select({ name: counterparties.name })
    .from(counterparties)
    .where(and(eq(counterparties.id, id), eq(counterparties.companyId, companyId)));
  return s?.name ?? null;
}

export const EXPENSE_PAGE_SIZE = 25;

export const expenseQuerySchema = z.object({
  q: z.string().max(100).optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  status: z.enum(["paid", "unpaid"]).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).default("date_desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type ExpenseQuery = z.infer<typeof expenseQuerySchema>;

function conditions(companyId: string, q: Partial<ExpenseQuery>): SQL[] {
  const c: SQL[] = [eq(expenses.companyId, companyId)];
  const text = q.q?.trim();
  if (text) {
    const pattern = `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    c.push(
      or(
        ilike(expenses.description, pattern),
        ilike(expenses.supplierName, pattern),
        ilike(expenses.reference, pattern),
      )!,
    );
  }
  if (q.category) c.push(eq(expenses.category, q.category));
  if (q.status) c.push(eq(expenses.status, q.status));
  if (q.from) c.push(gte(expenses.expenseDate, q.from));
  if (q.to) c.push(lte(expenses.expenseDate, q.to));
  return c;
}

/** One page of expenses (finance.view), searched, filtered and sorted in the database. */
export async function searchExpenses(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  query: unknown,
): Promise<{ expenses: ExpenseView[]; total: number; page: number; pageSize: number }> {
  await requireCompanyAccess(db, actor, companyId, "finance.view");
  const q = expenseQuerySchema.parse(query);
  const gross = sql`${expenses.netAmount} + ${expenses.taxAmount}`;
  const order: SQL[] =
    q.sort === "date_asc"
      ? [asc(expenses.expenseDate)]
      : q.sort === "amount_desc"
        ? [asc(expenses.currency), sql`${gross} desc`]
        : q.sort === "amount_asc"
          ? [asc(expenses.currency), sql`${gross} asc`]
          : [desc(expenses.expenseDate)];
  order.push(desc(expenses.createdAt), asc(expenses.id));
  const rows = await db
    .select({
      row: expenses,
      supplier: counterparties.name,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(expenses)
    .leftJoin(counterparties, eq(counterparties.id, expenses.supplierId))
    .where(and(...conditions(companyId, q)))
    .orderBy(...order)
    .limit(EXPENSE_PAGE_SIZE)
    .offset((q.page - 1) * EXPENSE_PAGE_SIZE);
  return {
    expenses: rows.map((r) => toView(r.row, r.supplier)),
    total: rows[0]?.total ?? 0,
    page: q.page,
    pageSize: EXPENSE_PAGE_SIZE,
  };
}

/** All expenses matching the filters (finance.view), for CSV export and reports (max 20 000). */
export async function allExpenses(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  query: Partial<ExpenseQuery> = {},
): Promise<ExpenseView[]> {
  await requireCompanyAccess(db, actor, companyId, "finance.view");
  return allExpensesUnchecked(db, companyId, query);
}

export async function allExpensesUnchecked(
  db: DbOrTx,
  companyId: string,
  query: Partial<ExpenseQuery> = {},
): Promise<ExpenseView[]> {
  const rows = await db
    .select({ row: expenses, supplier: counterparties.name })
    .from(expenses)
    .leftJoin(counterparties, eq(counterparties.id, expenses.supplierId))
    .where(and(...conditions(companyId, query)))
    .orderBy(asc(expenses.expenseDate), asc(expenses.createdAt))
    .limit(20_000);
  return rows.map((r) => toView(r.row, r.supplier));
}

export async function getExpense(db: DbOrTx, actor: Actor, companyId: string, id: string) {
  await requireCompanyAccess(db, actor, companyId, "finance.view");
  const [row] = await db
    .select({ row: expenses, supplier: counterparties.name })
    .from(expenses)
    .leftJoin(counterparties, eq(counterparties.id, expenses.supplierId))
    .where(and(eq(expenses.id, id), eq(expenses.companyId, companyId)));
  if (!row) throw new RecordNotFoundError();
  return toView(row.row, row.supplier);
}

/** Adds an expense (finance.manage). Invalid → 422 with every finding. */
export async function createExpense(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<ExpenseView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "finance.manage");
    const values = await validate(tx, companyId, createSchema.parse(input));
    const [row] = await tx
      .insert(expenses)
      .values({ ...values, companyId, createdByUserId: actor.userId })
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "expense.created",
      entityType: "expense",
      entityId: row!.id,
      metadata: { category: row!.category, status: row!.status },
    });
    return toView(row!, await supplierName(tx, companyId, row!.supplierId));
  });
}

/** Changes an expense (finance.manage, `expectedVersion`). Stale → 409; unknown → 404. */
export async function updateExpense(
  db: Database,
  actor: Actor,
  companyId: string,
  id: string,
  input: unknown,
): Promise<ExpenseView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "finance.manage");
    const { expectedVersion, ...data } = updateSchema.parse(input);
    const [current] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.companyId, companyId)))
      .for("update");
    if (!current) throw new RecordNotFoundError();
    if (current.version !== expectedVersion) throw new RecordVersionConflictError();
    const values = await validate(tx, companyId, data);
    const changed = (Object.keys(values) as (keyof Values)[]).filter((k) => {
      const a = values[k];
      const b = current[k as keyof Row];
      if (k === "netAmount" || k === "taxAmount")
        return Money.of(String(a), "EUR").compare(Money.of(String(b), "EUR")) !== 0;
      return a !== b;
    });
    if (changed.length === 0) return toView(current);
    const [row] = await tx
      .update(expenses)
      .set({ ...values, version: current.version + 1 })
      .where(and(eq(expenses.id, id), eq(expenses.companyId, companyId)))
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "expense.updated",
      entityType: "expense",
      entityId: id,
      metadata: { changed, version: row!.version },
    });
    return toView(row!, await supplierName(tx, companyId, row!.supplierId));
  });
}

/** Deletes an expense (finance.manage). Unknown → 404. */
export async function deleteExpense(
  db: Database,
  actor: Actor,
  companyId: string,
  id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "finance.manage");
    const deleted = await tx
      .delete(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.companyId, companyId)))
      .returning({ id: expenses.id, category: expenses.category });
    if (deleted.length === 0) throw new RecordNotFoundError();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "expense.deleted",
      entityType: "expense",
      entityId: id,
      metadata: { category: deleted[0]!.category },
    });
  });
}
