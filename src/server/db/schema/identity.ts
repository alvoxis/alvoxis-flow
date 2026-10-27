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
 * An invitation to join a company with a role. Only the SHA-256 hash of the link token is stored;
 * the token itself appears once, in the email or the inviter's copy of the link. An invitation is
 * accepted by a signed-in user whose verified email equals `email`, and it expires after 7 days.
 * At most one open (neither accepted nor revoked) invitation per company and email.
 */
export const companyInvitations = pgTable(
  "company_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Stored lower-cased. */
    email: text("email").notNull(),
    roleId: uuid("role_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("company_invitations_token_uq").on(t.tokenHash),
    uniqueIndex("company_invitations_open_uq")
      .on(t.companyId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check("company_invitations_email_lowercase_ck", sql`${t.email} = lower(${t.email})`),
    foreignKey({
      name: "company_invitations_role_same_company_fk",
      columns: [t.roleId, t.companyId],
      foreignColumns: [roles.id, roles.companyId],
    }).onDelete("cascade"),
  ],
);

/**
 * The company's subscription as last read from Stripe (Stripe is the source of truth; this row is a
 * cache refreshed on checkout return and whenever the billing page loads). No card data is stored.
 */
export const companyBilling = pgTable(
  "company_billing",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** flow (the one plan); basic | pro | business on rows of the earlier pricing; null without one. */
    plan: text("plan"),
    /** Stripe subscription status (trialing, active, past_due, canceled, …); null without one. */
    status: text("status"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** A trial was already given to this company (never a second one). */
    trialUsed: boolean("trial_used").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("company_billing_customer_uq").on(t.stripeCustomerId),
    check(
      "company_billing_plan_ck",
      sql`${t.plan} is null or ${t.plan} in ('flow', 'basic', 'pro', 'business')`,
    ),
  ],
);

/**
 * Stripe webhook events already handled (idempotency). An event id is inserted in the same
 * transaction that applies it, so a redelivered or concurrent duplicate does nothing, and an event
 * whose processing failed is not recorded and is retried by Stripe. Only ids and types are kept.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    /** Company the event was matched to (null: unknown customer, ignored). */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("billing_events_company_idx").on(t.companyId, t.receivedAt)],
);

/**
 * Time-limited internal access without a subscription, granted by an operator (testing, support).
 * One per company; granting again replaces it. Every grant and revocation is audited.
 */
export const companyAccessGrants = pgTable(
  "company_access_grants",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("company_access_grants_reason_ck", sql`length(trim(${t.reason})) >= 5`)],
);

/**
 * Operators of the SaaS (not company roles). Granted and revoked only by the operator script
 * `pnpm admin:grant` (never through the web application), and every change is audited.
 */
export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
