import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies, users } from "./identity";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * Customers and suppliers of a company (one record may be both). Documents keep their own frozen
 * copy of the buyer; choosing a customer in the editor only copies these details into the draft.
 * Records are archived, never deleted.
 */
export const counterparties = pgTable(
  "counterparties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    isCustomer: boolean("is_customer").notNull().default(false),
    isSupplier: boolean("is_supplier").notNull().default(false),
    name: text("name").notNull(),
    registrationNumber: text("registration_number"),
    vatNumber: text("vat_number"),
    email: text("email"),
    phone: text("phone"),
    contactName: text("contact_name"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    postalCode: text("postal_code"),
    city: text("city"),
    /** ISO 3166-1 alpha-2. */
    countryCode: text("country_code"),
    /** Default payment term for invoices to this customer, in days. */
    paymentTermDays: integer("payment_term_days"),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    unique("counterparties_id_company_uq").on(t.id, t.companyId),
    // A registration number identifies one active record per company.
    uniqueIndex("counterparties_active_registration_uq")
      .on(t.companyId, t.registrationNumber)
      .where(sql`${t.archivedAt} is null and ${t.registrationNumber} is not null`),
    index("counterparties_company_name_idx").on(t.companyId, t.name),
    check("counterparties_role_ck", sql`${t.isCustomer} or ${t.isSupplier}`),
    check("counterparties_name_ck", sql`length(trim(${t.name})) > 0`),
    check(
      "counterparties_country_ck",
      sql`${t.countryCode} is null or ${t.countryCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      "counterparties_payment_term_ck",
      sql`${t.paymentTermDays} is null or ${t.paymentTermDays} between 0 and 365`,
    ),
    check("counterparties_version_ck", sql`${t.version} > 0`),
  ],
);
