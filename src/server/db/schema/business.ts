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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { taxCategories } from "./documents";
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

export const productKind = pgEnum("product_kind", ["goods", "service"]);

/**
 * Products and services a company sells or buys. Prices are net, in the product's currency, with
 * up to 4 decimals (like document lines). Adding a product to a document copies its name, unit,
 * price and tax category into the line; documents keep their own copy. `trackStock` goods have
 * stock levels in the inventory module. Archived, never deleted.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: productKind("kind").notNull().default("goods"),
    /** Stock-keeping code, unique among the company's active products. */
    sku: text("sku"),
    name: text("name").notNull(),
    description: text("description"),
    unit: text("unit").notNull().default("pcs"),
    barcode: text("barcode"),
    currency: text("currency").notNull().default("EUR"),
    salePrice: numeric("sale_price", { precision: 18, scale: 4 }),
    purchasePrice: numeric("purchase_price", { precision: 18, scale: 4 }),
    /** Default tax category on document lines (same company; never a default otherwise). */
    taxCategoryId: uuid("tax_category_id"),
    trackStock: boolean("track_stock").notNull().default(false),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    unique("products_id_company_uq").on(t.id, t.companyId),
    uniqueIndex("products_active_sku_uq")
      .on(t.companyId, t.sku)
      .where(sql`${t.archivedAt} is null and ${t.sku} is not null`),
    index("products_company_name_idx").on(t.companyId, t.name),
    foreignKey({
      name: "products_tax_category_same_company_fk",
      columns: [t.taxCategoryId, t.companyId],
      foreignColumns: [taxCategories.id, taxCategories.companyId],
    }).onDelete("restrict"),
    check("products_name_ck", sql`length(trim(${t.name})) > 0`),
    check("products_unit_ck", sql`length(trim(${t.unit})) > 0`),
    check("products_currency_ck", sql`${t.currency} in ('EUR', 'PLN')`),
    check("products_sale_price_ck", sql`${t.salePrice} is null or ${t.salePrice} >= 0`),
    check("products_purchase_price_ck", sql`${t.purchasePrice} is null or ${t.purchasePrice} >= 0`),
    // Only goods have stock.
    check("products_track_stock_ck", sql`not ${t.trackStock} or ${t.kind} = 'goods'`),
    check("products_version_ck", sql`${t.version} > 0`),
  ],
);

/** Places where a company keeps stock. One active default; archived only when empty. */
export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("warehouses_id_company_uq").on(t.id, t.companyId),
    unique("warehouses_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("warehouses_one_default_uq")
      .on(t.companyId)
      .where(sql`${t.isDefault} and ${t.archivedAt} is null`),
    check("warehouses_code_ck", sql`${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'`),
    check("warehouses_name_ck", sql`length(trim(${t.name})) > 0`),
    check("warehouses_version_ck", sql`${t.version} > 0`),
  ],
);

export const stockMovementKind = pgEnum("stock_movement_kind", [
  "receipt",
  "issue",
  "adjustment",
  "transfer_out",
  "transfer_in",
  "production_consume",
  "production_output",
]);

/**
 * The stock ledger: every change of a product's quantity in a warehouse, signed (in > 0, out < 0).
 * A balance is the sum of its movements. Append-only (a trigger blocks UPDATE and DELETE);
 * mistakes are corrected with new movements. Both halves of a transfer, and all movements of a
 * production order, share a `groupId`.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid("product_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    kind: stockMovementKind("kind").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    /** Net cost per unit in the product's currency (receipts; optional). */
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
    /** YYYY-MM-DD: when the goods moved. */
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    reference: text("reference"),
    note: text("note"),
    groupId: uuid("group_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "stock_movements_product_same_company_fk",
      columns: [t.productId, t.companyId],
      foreignColumns: [products.id, products.companyId],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_movements_warehouse_same_company_fk",
      columns: [t.warehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }).onDelete("restrict"),
    index("stock_movements_balance_idx").on(t.companyId, t.productId, t.warehouseId),
    index("stock_movements_company_created_idx").on(t.companyId, t.createdAt),
    index("stock_movements_group_idx").on(t.groupId),
    check("stock_movements_quantity_ck", sql`${t.quantity} <> 0`),
    // Inbound kinds add stock, outbound kinds remove it; adjustments go either way.
    check(
      "stock_movements_sign_ck",
      sql`(${t.kind} in ('receipt', 'transfer_in', 'production_output') and ${t.quantity} > 0)
        or (${t.kind} in ('issue', 'transfer_out', 'production_consume') and ${t.quantity} < 0)
        or ${t.kind} = 'adjustment'`,
    ),
    check("stock_movements_unit_cost_ck", sql`${t.unitCost} is null or ${t.unitCost} >= 0`),
  ],
);
