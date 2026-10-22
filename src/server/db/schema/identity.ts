import { sql } from "drizzle-orm";
import { type PdfAccent } from "@/lib/pdf-accent";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const countryCode = pgEnum("country_code", ["LV", "LT", "EE", "PL"]);
export const localeCode = pgEnum("locale_code", ["en", "ru", "lv", "lt", "et"]);
export const membershipStatus = pgEnum("membership_status", ["invited", "active", "suspended"]);

/**
 * Global user identity. Not tenant-scoped: one user may belong to several companies.
 * Credentials and sessions are added in the authentication stage.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lower-cased; uniqueness enforced on lower(email). */
    email: text("email").notNull(),
    displayName: text("display_name"),
    locale: localeCode("locale").notNull().default("en"),
    /** Required by the auth library; kept in sync with email_verified_at by the auth hooks. */
    emailVerified: boolean("email_verified").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /** Avatar URL from an identity provider (e.g. Google). Display only. */
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    check("users_email_lowercase_ck", sql`${t.email} = lower(${t.email})`),
  ],
);

/** Tenant root. Every tenant-scoped table references companies.id. */
export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    country: countryCode("country").notNull(),
    registrationNumber: text("registration_number"),
    vatNumber: text("vat_number"),
    /** Registered address (country = `country`). All optional: older companies have none. */
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    postalCode: text("postal_code"),
    city: text("city"),
    defaultLocale: localeCode("default_locale").notNull().default("en"),
    /** Accent colour of the company's document PDFs, from the fixed palette in lib/pdf-accent. */
    pdfAccent: text("pdf_accent").$type<PdfAccent>().notNull().default("navy"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("companies_name_not_blank_ck", sql`length(trim(${t.name})) > 0`),
    check(
      "companies_pdf_accent_ck",
      sql`${t.pdfAccent} in ('navy', 'graphite', 'blue', 'teal', 'green', 'burgundy')`,
    ),
  ],
);

/** Global catalog of permission keys (mirrors src/server/auth/permissions.ts). */
export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Roles are owned by a company so each tenant can configure its own permissions.
 * System roles (owner, administrator, …) are created from templates for every company.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    requiresTwoFactor: boolean("requires_two_factor").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique("roles_company_key_uq").on(t.companyId, t.key),
    // Target for composite foreign keys that guarantee same-tenant references.
    unique("roles_id_company_uq").on(t.id, t.companyId),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

/**
 * Links a user to a company with exactly one role. The composite foreign key
 * (role_id, company_id) → roles(id, company_id) makes it impossible at the database level
 * to assign a role that belongs to a different company.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull(),
    status: membershipStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    unique("memberships_company_user_uq").on(t.companyId, t.userId),
    index("memberships_user_idx").on(t.userId),
    foreignKey({
      name: "memberships_role_same_company_fk",
      columns: [t.roleId, t.companyId],
      foreignColumns: [roles.id, roles.companyId],
    }).onDelete("restrict"),
  ],
);

/**
 * Append-only audit trail. UPDATE and DELETE are blocked by a database trigger
 * (see migration 0001). company_id is null for account-level events (e.g. sign-in).
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_company_created_idx").on(t.companyId, t.createdAt),
    index("audit_logs_actor_idx").on(t.actorUserId),
  ],
);
