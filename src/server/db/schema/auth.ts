import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * Tables used by the authentication library (Better Auth). Property names follow the library's
 * field names; column names follow the project's snake_case convention. All ids are UUIDs.
 * Users are never hard-deleted (audit logs reference them), so the cascades below only matter
 * for test databases.
 */
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Opaque session token (cookie value is a signed form of it). */
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /**
     * Set only when THIS session passed a second factor (TOTP or backup code). Company access
     * for roles that require 2FA depends on it, so sessions created without a second factor
     * (e.g. Google sign-in) cannot reach company data until the user completes a challenge.
     */
    twoFactorVerifiedAt: timestamp("two_factor_verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("auth_sessions_token_uq").on(t.token),
    index("auth_sessions_user_idx").on(t.userId),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider-side account id (Google "sub"; the user id for email/password). */
    accountId: text("account_id").notNull(),
    /** "credential" for email/password, "google" for Google. */
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** OAuth tokens are encrypted by the auth library before storage. */
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** Password hash (scrypt) for the "credential" provider only. */
    password: text("password"),
    ...timestamps,
  },
  (t) => [
    unique("auth_accounts_provider_account_uq").on(t.providerId, t.accountId),
    index("auth_accounts_user_idx").on(t.userId),
  ],
);

/** Email-verification and password-reset tokens. Identifiers are stored HASHED. */
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

/** TOTP secret and backup codes — both encrypted with BETTER_AUTH_SECRET. */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** False until the user proves possession of the authenticator during enrollment. */
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [unique("two_factors_user_uq").on(t.userId)],
);

/** Rate-limit counters shared by all application instances. */
export const authRateLimits = pgTable("auth_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique("auth_rate_limits_key_uq"),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/**
 * Replay protection for TOTP codes: a code accepted once for a user cannot be accepted again
 * while it is still valid. Only an HMAC of the code is stored.
 */
export const twoFactorUsedCodes = pgTable(
  "two_factor_used_codes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.codeHash] }),
    index("two_factor_used_codes_expires_idx").on(t.expiresAt),
  ],
);
