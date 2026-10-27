import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type CurrencyCode, Money } from "@/lib/money";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { documentPayments, documents } from "@/server/db/schema";
import {
  RecordNotFoundError,
  RecordStateError,
  RecordTakenError,
  RecordValidationError,
} from "@/server/records/errors";
import { type InvoiceBalance, invoiceBalance, isIsoDate } from "../domain/receivables";
import { PAYMENT_METHODS } from "../domain/expenses";

/**
 * Payments received on issued invoices (finance.view to read, finance.manage to record or void;
 * the invoice itself needs documents.view). Recording locks the invoice row, recomputes the open
 * balance from the database and refuses anything above it, so two people recording at once cannot
 * overpay an invoice. Issued invoices are never changed: the payment status is derived.
 */

export interface PaymentView {
  id: string;
  amount: string;
  currency: CurrencyCode;
  paidOn: string;
  method: (typeof PAYMENT_METHODS)[number];
  reference: string | null;
  note: string | null;
  source: string;
  createdAt: string;
  voided: boolean;
}

export interface InvoicePaymentsView extends InvoiceBalance {
  documentId: string;
  currency: CurrencyCode;
  grossTotal: string;
  credited: string;
  paid: string;
  dueDate: string | null;
  payments: PaymentView[];
}

export interface OpenInvoiceRow extends InvoiceBalance {
  id: string;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: CurrencyCode;
  grossTotal: string;
  credited: string;
  paid: string;
  buyerName: string | null;
}

/** Today in UTC as YYYY-MM-DD (dates in this application are calendar dates without time). */
export const todayIso = () => new Date().toISOString().slice(0, 10);

const toView = (r: typeof documentPayments.$inferSelect): PaymentView => ({
  id: r.id,
  amount: Money.of(r.amount, r.currency).toFixed(),
  currency: r.currency,
  paidOn: r.paidOn,
  method: r.method,
  reference: r.reference,
  note: r.note,
  source: r.source,
  createdAt: r.createdAt.toISOString(),
  voided: r.voidedAt !== null,
});

/** Credited (≤ 0) and paid (≥ 0) sums of one invoice, straight from the database. */
async function sums(db: DbOrTx, companyId: string, documentId: string) {
  const res = await db.execute<{ credited: string; paid: string }>(sql`
    select
      coalesce((select sum(c.gross_total) from documents c
        where c.company_id = ${companyId} and c.related_document_id = ${documentId}
        and c.type = 'credit_note' and c.status = 'issued'), 0)::text as credited,
      coalesce((select sum(p.amount) from document_payments p
        where p.company_id = ${companyId} and p.document_id = ${documentId}
        and p.voided_at is null), 0)::text as paid`);
  const row = res.rows[0];
  return { credited: row?.credited ?? "0", paid: row?.paid ?? "0" };
}

async function loadInvoice(db: DbOrTx, companyId: string, documentId: string, lock = false) {
  const q = db
    .select({
      id: documents.id,
      type: documents.type,
      status: documents.status,
      currency: documents.currency,
      grossTotal: documents.grossTotal,
      dueDate: documents.dueDate,
      issueDate: documents.issueDate,
      number: documents.number,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new RecordNotFoundError();
  if (row.type !== "invoice" || row.status !== "issued" || row.grossTotal === null)
    throw new RecordStateError("payments.notIssuedInvoice");
  return { ...row, grossTotal: row.grossTotal };
}

/** The invoice's payments and derived status (documents.view + finance.view). */
export async function invoicePayments(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  documentId: string,
): Promise<InvoicePaymentsView> {
  await requireCompanyAccess(db, actor, companyId, ["documents.view", "finance.view"]);
  const inv = await loadInvoice(db, companyId, documentId);
  const { credited, paid } = await sums(db, companyId, documentId);
  const rows = await db
    .select()
    .from(documentPayments)
    .where(
      and(eq(documentPayments.companyId, companyId), eq(documentPayments.documentId, documentId)),
    )
    .orderBy(asc(documentPayments.paidOn), asc(documentPayments.createdAt));
  const balance = invoiceBalance(
    { currency: inv.currency, grossTotal: inv.grossTotal, credited, paid, dueDate: inv.dueDate },
    todayIso(),
  );
  return {
    documentId,
    currency: inv.currency,
    grossTotal: Money.of(inv.grossTotal, inv.currency).toFixed(),
    credited: Money.of(credited, inv.currency).toFixed(),
    paid: Money.of(paid, inv.currency).toFixed(),
    dueDate: inv.dueDate,
    ...balance,
    payments: rows.map(toView),
  };
}

const AMOUNT = /^\d{1,14}(\.\d{1,2})?$/;

const recordSchema = z.strictObject({
  amount: z.string().max(24),
  paidOn: z.string().max(10),
  method: z.enum(PAYMENT_METHODS),
  reference: z
    .string()
    .max(100)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
  note: z
    .string()
    .max(500)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
});

/**
 * Records a payment (finance.manage + documents.view). Refused: not an issued invoice → 409
 * payments.notIssuedInvoice; amount missing, zero, malformed or above the open balance, or a date
 * in the future → 422; the same reference already used on this invoice → 409 reference_taken.
 */
export async function recordPayment(
  db: Database,
  actor: Actor,
  companyId: string,
  documentId: string,
  input: unknown,
): Promise<InvoicePaymentsView> {
  const data = recordSchema.parse(input);
  await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, ["documents.view", "finance.manage"]);
    const inv = await loadInvoice(tx, companyId, documentId, true);
    const issues: { code: string; severity: "error"; path: string }[] = [];
    const amount = data.amount.trim().replace(",", ".");
    if (!AMOUNT.test(amount) || Money.of(amount, inv.currency).isZero())
      issues.push({ code: "payment.amount.invalid", severity: "error", path: "amount" });
    if (!isIsoDate(data.paidOn))
      issues.push({ code: "payment.paidOn.invalid", severity: "error", path: "paidOn" });
    else if (data.paidOn > todayIso())
      issues.push({ code: "payment.paidOn.future", severity: "error", path: "paidOn" });
    if (issues.length === 0) {
      const { credited, paid } = await sums(tx, companyId, documentId);
      const open = invoiceBalance(
        {
          currency: inv.currency,
          grossTotal: inv.grossTotal,
          credited,
          paid,
          dueDate: inv.dueDate,
        },
        todayIso(),
      );
      if (Money.of(amount, inv.currency).compare(Money.of(open.balance, inv.currency)) > 0)
        issues.push({ code: "payment.amount.exceedsBalance", severity: "error", path: "amount" });
    }
    if (issues.length) throw new RecordValidationError(issues);
    if (data.reference) {
      const [dup] = await tx
        .select({ id: documentPayments.id })
        .from(documentPayments)
        .where(
          and(
            eq(documentPayments.documentId, documentId),
            eq(documentPayments.reference, data.reference),
            isNull(documentPayments.voidedAt),
          ),
        );
      if (dup) throw new RecordTakenError("reference_taken");
    }
    const [row] = await tx
      .insert(documentPayments)
      .values({
        companyId,
        documentId,
        amount,
        currency: inv.currency,
        paidOn: data.paidOn,
        method: data.method,
        reference: data.reference ?? null,
        note: data.note ?? null,
        createdByUserId: actor.userId,
      })
      .returning({ id: documentPayments.id });
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "payment.recorded",
      entityType: "document",
      entityId: documentId,
      metadata: { paymentId: row!.id, method: data.method },
    });
  });
  return invoicePayments(db, actor, companyId, documentId);
}

/** Voids a payment (finance.manage): it stays in the history, no longer counts. Twice → 409. */
export async function voidPayment(
  db: Database,
  actor: Actor,
  companyId: string,
  documentId: string,
  paymentId: string,
): Promise<InvoicePaymentsView> {
  await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, ["documents.view", "finance.manage"]);
    const [row] = await tx
      .select()
      .from(documentPayments)
      .where(
        and(
          eq(documentPayments.id, paymentId),
          eq(documentPayments.companyId, companyId),
          eq(documentPayments.documentId, documentId),
        ),
      )
      .for("update");
    if (!row) throw new RecordNotFoundError();
    if (row.voidedAt) throw new RecordStateError("payments.alreadyVoided");
    await tx
      .update(documentPayments)
      .set({ voidedAt: new Date(), voidedByUserId: actor.userId })
      .where(eq(documentPayments.id, paymentId));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "payment.voided",
      entityType: "document",
      entityId: documentId,
      metadata: { paymentId },
    });
  });
  return invoicePayments(db, actor, companyId, documentId);
}

/**
 * Every issued invoice of the company with its derived balance and status (documents.view +
 * finance.view), optionally limited to an issue-date range. One query; balances in the database's
 * numeric arithmetic, status computed with decimal money.
 */
export async function invoiceBalances(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { from?: string; to?: string; asOf?: string } = {},
): Promise<OpenInvoiceRow[]> {
  await requireCompanyAccess(db, actor, companyId, ["documents.view", "finance.view"]);
  return invoiceBalancesUnchecked(db, companyId, opts);
}

/** invoiceBalances without the access check, for callers that already hold the context. */
export async function invoiceBalancesUnchecked(
  db: DbOrTx,
  companyId: string,
  opts: { from?: string; to?: string; asOf?: string } = {},
): Promise<OpenInvoiceRow[]> {
  const rows = await db
    .select({
      id: documents.id,
      number: documents.number,
      issueDate: documents.issueDate,
      dueDate: documents.dueDate,
      currency: documents.currency,
      grossTotal: sql<string>`${documents.grossTotal}::text`,
      buyerName: sql<string | null>`${documents.buyer}->>'name'`,
      // Qualified explicitly: the subqueries must refer to the outer invoice row.
      credited: sql<string>`coalesce((select sum(c.gross_total) from documents c
        where c.company_id = "documents"."company_id" and c.related_document_id = "documents"."id"
        and c.type = 'credit_note' and c.status = 'issued'), 0)::text`,
      paid: sql<string>`coalesce((select sum(p.amount) from document_payments p
        where p.company_id = "documents"."company_id" and p.document_id = "documents"."id"
        and p.voided_at is null), 0)::text`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.type, "invoice"),
        eq(documents.status, "issued"),
        opts.from ? sql`${documents.issueDate} >= ${opts.from}` : undefined,
        opts.to ? sql`${documents.issueDate} <= ${opts.to}` : undefined,
      ),
    )
    .orderBy(asc(documents.issueDate), asc(documents.number));
  const asOf = opts.asOf ?? todayIso();
  return rows.map((r) => ({
    ...r,
    grossTotal: Money.of(r.grossTotal, r.currency).toFixed(),
    credited: Money.of(r.credited, r.currency).toFixed(),
    paid: Money.of(r.paid, r.currency).toFixed(),
    ...invoiceBalance(
      {
        currency: r.currency,
        grossTotal: r.grossTotal,
        credited: r.credited,
        paid: r.paid,
        dueDate: r.dueDate,
      },
      asOf,
    ),
  }));
}
