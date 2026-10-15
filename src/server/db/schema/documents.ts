import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type ExchangeRate } from "@/lib/money";
import {
  type BankAccountSnapshot,
  type DocumentDraft,
  type PartySnapshot,
  type TaxCategorySnapshot,
  type TaxSummaryRow,
} from "@/modules/documents/domain/types";
import { companies, localeCode, users } from "./identity";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const documentType = pgEnum("document_type", [
  "invoice",
  "proforma",
  "credit_note",
  "delivery_note",
]);
export const documentStatus = pgEnum("document_status", ["draft", "issued"]);
export const documentOrigin = pgEnum("document_origin", ["created", "imported"]);
export const documentRelationKind = pgEnum("document_relation_kind", [
  "credits",
  "converted_from",
  "delivers",
  "replaces",
]);
export const currencyCode = pgEnum("currency_code", ["EUR", "PLN"]);
export const numberingResetPolicy = pgEnum("numbering_reset_policy", ["never", "yearly"]);
export const lineKind = pgEnum("document_line_kind", ["item", "charge"]);

export const documentNumberSeries = pgTable(
  "document_number_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    documentType: documentType("document_type").notNull(),
    name: text("name").notNull(),
    pattern: text("pattern").notNull(),
    resetPolicy: numberingResetPolicy("reset_policy").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("document_number_series_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("document_number_series_one_default_uq")
      .on(t.companyId, t.documentType)
      .where(sql`${t.isDefault} and ${t.archivedAt} is null`),
  ],
);

/** One counter per series and period ("2026" for yearly series, "all" otherwise). */
export const documentNumberCounters = pgTable(
  "document_number_counters",
  {
    seriesId: uuid("series_id").notNull(),
    companyId: uuid("company_id").notNull(),
    periodKey: text("period_key").notNull(),
    lastValue: integer("last_value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.periodKey] }),
    foreignKey({
      name: "document_number_counters_series_fk",
      columns: [t.seriesId, t.companyId],
      foreignColumns: [documentNumberSeries.id, documentNumberSeries.companyId],
    }).onDelete("restrict"),
    check("document_number_counters_positive_ck", sql`${t.lastValue} > 0`),
  ],
);

/**
 * Documents of all types. Drafts are editable; once `issued`, a database trigger blocks any
 * UPDATE or DELETE of the row and of its lines (migration 0003). `snapshot` holds the canonical
 * issued content and `content_hash` its SHA-256.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    type: documentType("type").notNull(),
    status: documentStatus("status").notNull().default("draft"),
    origin: documentOrigin("origin").notNull().default("created"),
    seriesId: uuid("series_id"),
    number: text("number"),
    language: localeCode("language").notNull(),
    currency: currencyCode("currency").notNull(),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }),
    supplyDate: date("supply_date", { mode: "string" }),
    validUntil: date("valid_until", { mode: "string" }),
    seller: jsonb("seller").$type<PartySnapshot>().notNull(),
    buyer: jsonb("buyer").$type<PartySnapshot>().notNull(),
    deliverTo: jsonb("deliver_to").$type<PartySnapshot>(),
    bankAccounts: jsonb("bank_accounts").$type<BankAccountSnapshot[]>().notNull().default([]),
    buyerReference: text("buyer_reference"),
    paymentTerms: text("payment_terms"),
    notes: text("notes"),
    footer: text("footer"),
    exchangeRate: jsonb("exchange_rate").$type<ExchangeRate>(),
    relationKind: documentRelationKind("relation_kind"),
    relatedDocumentId: uuid("related_document_id"),
    netTotal: numeric("net_total", { precision: 18, scale: 2 }),
    taxTotal: numeric("tax_total", { precision: 18, scale: 2 }),
    grossTotal: numeric("gross_total", { precision: 18, scale: 2 }),
    taxSummary: jsonb("tax_summary").$type<TaxSummaryRow[]>(),
    snapshot: jsonb("snapshot").$type<DocumentDraft & Record<string, unknown>>(),
    contentHash: text("content_hash"),
    version: integer("version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("documents_id_company_uq").on(t.id, t.companyId),
    unique("documents_company_type_number_uq").on(t.companyId, t.type, t.number),
    index("documents_company_issue_date_idx").on(t.companyId, t.issueDate),
    index("documents_related_idx").on(t.relatedDocumentId),
    foreignKey({
      name: "documents_series_same_company_fk",
      columns: [t.seriesId, t.companyId],
      foreignColumns: [documentNumberSeries.id, documentNumberSeries.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "documents_related_same_company_fk",
      columns: [t.relatedDocumentId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }).onDelete("restrict"),
    check(
      "documents_issued_complete_ck",
      sql`${t.status} = 'draft' or (${t.number} is not null and ${t.issuedAt} is not null and ${t.contentHash} is not null and ${t.snapshot} is not null)`,
    ),
    check(
      "documents_relation_pair_ck",
      sql`(${t.relationKind} is null) = (${t.relatedDocumentId} is null)`,
    ),
    check(
      "documents_credit_note_relation_ck",
      sql`${t.type} <> 'credit_note' or ${t.relationKind} = 'credits'`,
    ),
    check(
      "documents_due_after_issue_ck",
      sql`${t.dueDate} is null or ${t.dueDate} >= ${t.issueDate}`,
    ),
  ],
);

export const documentLines = pgTable(
  "document_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
    kind: lineKind("kind").notNull().default("item"),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unit: text("unit"),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }),
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }),
    taxCategory: jsonb("tax_category").$type<TaxCategorySnapshot>(),
    weightKg: numeric("weight_kg", { precision: 14, scale: 3 }),
    sourceLineId: uuid("source_line_id"),
    netAmount: numeric("net_amount", { precision: 18, scale: 2 }),
  },
  (t) => [
    unique("document_lines_id_company_uq").on(t.id, t.companyId),
    unique("document_lines_position_uq").on(t.documentId, t.position),
    index("document_lines_source_idx").on(t.sourceLineId),
    foreignKey({
      name: "document_lines_document_fk",
      columns: [t.documentId, t.companyId],
      foreignColumns: [documents.id, documents.companyId],
    }).onDelete("cascade"),
    foreignKey({
      name: "document_lines_source_same_company_fk",
      columns: [t.sourceLineId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }).onDelete("restrict"),
  ],
);
