import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { counterparties } from "./business";
import { currencyCode, documents } from "./documents";
import { companies, users } from "./identity";

export const paymentMethod = pgEnum("payment_method", ["bank_transfer", "card", "cash", "other"]);

/**
 * Payments received against issued invoices, recorded by hand (`source` is reserved for future
 * bank imports; nothing is imported automatically). A payment is never edited: a wrong one is
 * voided (kept, with who and when) and recorded again, so the history stays complete. The amount
 * is in the invoice's currency, positive, and the service refuses payments above the open balance
 * (locking the invoice row while it checks). A reference is used once per invoice among valid
 * payments, which stops the same bank transfer from being entered twice.
 */
export const documentPayments = pgTable(
  "document_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: currencyCode("currency").notNull(),
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    method: paymentMethod("method").notNull(),
    reference: text("reference"),
    note: text("note"),
    source: text("source").notNull().default("manual"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    foreignKey({
      name: "document_payments_document_same_company_fk",
      columns: [t.documentId, t.companyId],
      foreignColumns: [documents.id, documents.companyId],
    }).onDelete("restrict"),
    index("document_payments_document_idx").on(t.companyId, t.documentId),
    index("document_payments_company_paid_on_idx").on(t.companyId, t.paidOn),
    uniqueIndex("document_payments_reference_uq")
      .on(t.documentId, t.reference)
      .where(sql`${t.reference} is not null and ${t.voidedAt} is null`),
    check("document_payments_amount_ck", sql`${t.amount} > 0`),
    check("document_payments_source_ck", sql`${t.source} in ('manual', 'imported')`),
  ],
);

export const expenseStatus = pgEnum("expense_status", ["paid", "unpaid"]);
export const expenseRecurrence = pgEnum("expense_recurrence", [
  "none",
  "monthly",
  "quarterly",
  "yearly",
]);

/**
 * Company expenses (purchases, rent, fees …), entered by hand (`source` = manual; imports are not
 * implemented). Amounts are decimal strings in the expense's currency: `net_amount` plus
 * `tax_amount` (VAT or similar, as on the supplier's invoice) is the gross amount. Recoverable tax
 * is not a cost; non-recoverable tax is (see modules/finance/domain/expenses.ts), so VAT is never
 * counted twice. Unpaid expenses with a due date are the company's payables.
 */
export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    expenseDate: date("expense_date", { mode: "string" }).notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    supplierId: uuid("supplier_id"),
    /** Free-text supplier when no supplier record is linked. */
    supplierName: text("supplier_name"),
    currency: currencyCode("currency").notNull(),
    netAmount: numeric("net_amount", { precision: 18, scale: 2 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
    taxRecoverable: boolean("tax_recoverable").notNull().default(true),
    status: expenseStatus("status").notNull().default("paid"),
    dueDate: date("due_date", { mode: "string" }),
    paidOn: date("paid_on", { mode: "string" }),
    paymentMethod: paymentMethod("payment_method"),
    reference: text("reference"),
    notes: text("notes"),
    recurrence: expenseRecurrence("recurrence").notNull().default("none"),
    source: text("source").notNull().default("manual"),
    version: integer("version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: "expenses_supplier_same_company_fk",
      columns: [t.supplierId, t.companyId],
      foreignColumns: [counterparties.id, counterparties.companyId],
    }).onDelete("restrict"),
    index("expenses_company_date_idx").on(t.companyId, t.expenseDate),
    index("expenses_company_category_idx").on(t.companyId, t.category),
    check("expenses_net_ck", sql`${t.netAmount} >= 0`),
    check("expenses_tax_ck", sql`${t.taxAmount} >= 0`),
    check("expenses_description_ck", sql`length(trim(${t.description})) > 0`),
    check("expenses_paid_ck", sql`(${t.status} = 'paid') = (${t.paidOn} is not null)`),
    check("expenses_source_ck", sql`${t.source} in ('manual', 'imported')`),
    check("expenses_version_ck", sql`${t.version} > 0`),
  ],
);
