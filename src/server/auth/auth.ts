import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { type ServerEnv } from "@/config/env";
import { LOCALES } from "@/i18n/config";
import { recordAudit } from "@/server/audit/audit-log";
import { type Database } from "@/server/db/client";
import {
  authAccounts,
  authRateLimits,
  authSessions,
  authVerifications,
  twoFactors,
  twoFactorUsedCodes,
  users,
} from "@/server/db/schema";
import { asLocale, authEmail } from "@/server/notifications/auth-emails";
import { type Mailer } from "@/server/notifications/mailer";
import { userRequiresTwoFactor } from "./two-factor-policy";
import { deviceLabel } from "./user-agent";

export const AUTH_BASE_PATH = "/api/auth";
export const SESSION_EXPIRES_IN = 60 * 60 * 24 * 7; // 7 days
export const SESSION_UPDATE_AGE = 60 * 60; // refresh (and record activity) at most hourly
export const PASSWORD_MIN_LENGTH = 12;
export const RESET_TOKEN_EXPIRES_IN = 60 * 60; // 1 hour
const TOTP_REPLAY_WINDOW_SECONDS = 120; // covers the ±1 step tolerance of a 30s TOTP

export interface AuthDeps {
  db: Database;
  env: ServerEnv;
  mailer: Mailer;
}

/** Errors this app adds on top of the library's error codes (translated in the UI). */
export const APP_AUTH_ERRORS = {
  TWO_FACTOR_REQUIRED_FOR_ROLE: "TWO_FACTOR_REQUIRED_FOR_ROLE",
  CODE_ALREADY_USED: "CODE_ALREADY_USED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
} as const;

const RATE_LIMITS: Record<string, { window: number; max: number }> = {
  "/sign-in/email": { window: 60, max: 5 },
  "/sign-in/social": { window: 60, max: 10 },
  "/sign-up/email": { window: 300, max: 5 },
  "/request-password-reset": { window: 300, max: 3 },
  "/reset-password": { window: 300, max: 5 },
  "/send-verification-email": { window: 300, max: 3 },
  "/verify-email": { window: 300, max: 10 },
  "/change-password": { window: 300, max: 5 },
  "/two-factor/enable": { window: 60, max: 5 },
  "/two-factor/disable": { window: 60, max: 5 },
  "/two-factor/verify-totp": { window: 60, max: 5 },
  "/two-factor/verify-backup-code": { window: 60, max: 5 },
  "/two-factor/generate-backup-codes": { window: 300, max: 5 },
};

/** Enrollment state detected in the before-hook, consumed by the after-hook of the same request. */
const enrollmentRequests = new WeakSet<Request>();

function isApiError(value: unknown): value is APIError {
  return (
    value instanceof APIError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: string }).name === "APIError")
  );
}

function errorCode(value: unknown): string | null {
  if (!isApiError(value)) return null;
  const body = (value as unknown as { body?: { code?: string } }).body;
  return body?.code ?? (value as unknown as { status?: string }).status ?? "ERROR";
}

export function createAuth({ db, env, mailer }: AuthDeps) {
  const appUrl = env.APP_URL.replace(/\/$/, "");
  const secureCookies = appUrl.startsWith("https://");
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            prompt: "select_account" as const,
          },
        }
      : {};
  const accountLink = (locale: string, path: string) => `${appUrl}/${asLocale(locale)}${path}`;

  const hashCode = (userId: string, code: string) =>
    createHmac("sha256", env.BETTER_AUTH_SECRET)
      .update(`totp:${userId}:${code}`)
      .digest("base64url");

  const audit = (
    action: string,
    actorUserId: string | null,
    metadata: Record<string, unknown> = {},
    ip?: string | null,
    ua?: string | null,
  ) =>
    recordAudit(db, {
      companyId: null,
      actorUserId,
      action,
      entityType: "user",
      entityId: actorUserId ?? undefined,
      metadata,
      ipAddress: ip ?? undefined,
      userAgent: ua ?? undefined,
    }).catch((err: unknown) => {
      console.error(`[audit] failed to record ${action}`, err instanceof Error ? err.name : err);
    });

  const findUser = async (userId: string) =>
    (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];

  const sendSecurityEmail = async (
    kind: Parameters<typeof authEmail>[0],
    userId: string,
    values: Parameters<typeof authEmail>[3] = {},
  ) => {
    const user = await findUser(userId);
    if (!user) return;
    const result = await mailer.send(
      authEmail(kind, user.email, asLocale(user.locale), { name: user.displayName, ...values }),
    );
    if (result.status !== "sent")
      await audit("notification.email_not_delivered", userId, { kind, status: result.status });
  };

  /** User id of the person completing a 2FA challenge: from the session, or the pending sign-in cookie. */
  const twoFactorUserId = async (
    ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  ) => {
    const session = await getSessionFromCtx(ctx).catch(() => null);
    if (session) return { userId: session.user.id, hasSession: true };
    const cookie = ctx.context.createAuthCookie("two_factor");
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!identifier) return null;
    const record = await ctx.context.internalAdapter.findVerificationValue(identifier);
    return record ? { userId: record.value, hasSession: false } : null;
  };

  return betterAuth({
    appName: "ALVOXIS Flow",
    baseURL: appUrl,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [appUrl],
    telemetry: { enabled: false },
    logger: { level: env.LOG_LEVEL === "debug" ? "debug" : "warn" },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users,
        auth_sessions: authSessions,
        auth_accounts: authAccounts,
        auth_verifications: authVerifications,
        two_factors: twoFactors,
        auth_rate_limits: authRateLimits,
      },
    }),
    user: {
      modelName: "users",
      fields: { name: "displayName" },
      additionalFields: {
        locale: { type: "string", required: false, defaultValue: "en", input: true },
      },
    },
    session: {
      modelName: "auth_sessions",
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
      cookieCache: { enabled: false },
      additionalFields: {
        twoFactorVerifiedAt: { type: "date", required: false, input: false },
      },
    },
    account: {
      modelName: "auth_accounts",
      encryptOAuthTokens: true,
      // Google accounts are linked to an existing user only when Google reports the email as verified.
      accountLinking: { enabled: true, allowDifferentEmails: false },
    },
    verification: { modelName: "auth_verifications", storeIdentifier: "hashed" },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limits",
      window: 60,
      max: 100,
      customRules: RATE_LIMITS,
    },
    advanced: {
      cookiePrefix: "alvoxis",
      useSecureCookies: secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: secureCookies },
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: env.TRUSTED_IP_HEADER ? [env.TRUSTED_IP_HEADER] : [] },
    },
    // Session management goes through the app's audited service (no tokens sent to browsers);
    // email/SMS one-time codes are not offered (TOTP + recovery codes only).
    disabledPaths: [
      "/list-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
      "/two-factor/send-otp",
      "/two-factor/verify-otp",
      "/delete-user",
    ],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: RESET_TOKEN_EXPIRES_IN,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendSecurityEmail("reset", user.id, { link: url });
      },
      onExistingUserSignUp: async ({ user }) => {
        await sendSecurityEmail("existingAccount", user.id, {
          link: accountLink((user as { locale?: string }).locale ?? "en", "/sign-in"),
        });
        await audit("auth.sign_up_existing_email", user.id);
      },
      onPasswordReset: async ({ user }) => {
        await audit("auth.password_reset_completed", user.id);
        await sendSecurityEmail("passwordChanged", user.id, {
          link: accountLink((user as { locale?: string }).locale ?? "en", "/forgot-password"),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await sendSecurityEmail("verify", user.id, { link: url });
      },
      afterEmailVerification: async (user) => {
        await audit("auth.email_verified", user.id);
      },
    },
    socialProviders: google,
    plugins: [
      twoFactor({
        issuer: "ALVOXIS Flow",
        twoFactorTable: "two_factors",
        skipVerificationOnEnable: false,
        backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
      }),
      nextCookies(),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              email: user.email.toLowerCase(),
              locale: (LOCALES as readonly string[]).includes(String(user.locale))
                ? user.locale
                : "en",
            },
          }),
          after: async (user, ctx) => {
            await audit("auth.user_registered", user.id, { via: ctx?.path ?? null });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await findUser(session.userId);
            // Disabled users cannot obtain sessions by any method (password, Google, 2FA).
            if (!user || user.disabledAt) return false;
          },
          after: async (session, ctx) => {
            const path = ctx?.path ?? "";
            await audit(
              "auth.session_created",
              session.userId,
              { via: path, sessionId: session.id },
              session.ipAddress,
              session.userAgent,
            );
            // Enrollment/step-up replace an existing session: that is not a new sign-in.
            const isRefreshOfExisting =
              path.startsWith("/two-factor/") && ctx
                ? Boolean(await getSessionFromCtx(ctx).catch(() => null))
                : false;
            if (!isRefreshOfExisting) {
              const user = await findUser(session.userId);
              await sendSecurityEmail("newSignIn", session.userId, {
                device: deviceLabel(session.userAgent, "") || undefined,
                link: accountLink(user?.locale ?? "en", "/account/security"),
              });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const path = ctx.path;
        const body = (ctx.body ?? {}) as Record<string, unknown>;

        if (path === "/change-password") {
          // Policy: changing the password always signs out every other session.
          return { context: { body: { ...body, revokeOtherSessions: true } } };
        }

        if (path === "/two-factor/disable") {
          const session = await getSessionFromCtx(ctx);
          if (session && (await userRequiresTwoFactor(db, session.user.id))) {
            throw new APIError("FORBIDDEN", {
              code: APP_AUTH_ERRORS.TWO_FACTOR_REQUIRED_FOR_ROLE,
              message: "Two-factor authentication is required for your role",
            });
          }
        }

        if (path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code") {
          const who = await twoFactorUserId(ctx);
          if (who && path === "/two-factor/verify-totp" && typeof body.code === "string") {
            // Enrollment = TOTP secret exists but is not verified yet.
            const [tf] = await db
              .select({ verified: twoFactors.verified })
              .from(twoFactors)
              .where(eq(twoFactors.userId, who.userId));
            if (tf && !tf.verified && ctx.request) enrollmentRequests.add(ctx.request);
            // Replay protection: atomically claim the code; a second use within its validity fails.
            await db.delete(twoFactorUsedCodes).where(lt(twoFactorUsedCodes.expiresAt, new Date()));
            const claimed = await db
              .insert(twoFactorUsedCodes)
              .values({
                userId: who.userId,
                codeHash: hashCode(who.userId, body.code.trim()),
                expiresAt: new Date(Date.now() + TOTP_REPLAY_WINDOW_SECONDS * 1000),
              })
              .onConflictDoNothing()
              .returning();
            if (claimed.length === 0) {
              await audit("auth.two_factor_code_replay_blocked", who.userId);
              throw new APIError("UNAUTHORIZED", {
                code: APP_AUTH_ERRORS.CODE_ALREADY_USED,
                message: "This code was already used",
              });
            }
          }
          // "Trust this device" would skip the second factor on later sign-ins: not allowed.
          return { context: { body: { ...body, trustDevice: false } } };
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const path = ctx.path;
        const returned = ctx.context.returned;
        const failed = isApiError(returned);
        const ip = ctx.request?.headers.get(env.TRUSTED_IP_HEADER ?? "x-forwarded-for") ?? null;
        const ua = ctx.request?.headers.get("user-agent") ?? null;

        if (path === "/sign-in/email") {
          if (failed) {
            const email =
              typeof (ctx.body as { email?: unknown })?.email === "string"
                ? String((ctx.body as { email: string }).email).toLowerCase()
                : null;
            const [user] = email
              ? await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
              : [];
            await audit(
              "auth.sign_in_failed",
              user?.id ?? null,
              { code: errorCode(returned) },
              ip,
              ua,
            );
          } else if ((returned as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
            const [user] = await db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, String((ctx.body as { email: string }).email).toLowerCase()))
              .limit(1);
            await audit("auth.sign_in_two_factor_pending", user?.id ?? null, {}, ip, ua);
          }
          return;
        }

        if (path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code") {
          const enrollment = ctx.request ? enrollmentRequests.has(ctx.request) : false;
          if (ctx.request) enrollmentRequests.delete(ctx.request);
          if (failed) {
            const who = await twoFactorUserId(ctx).catch(() => null);
            await audit(
              "auth.two_factor_failed",
              who?.userId ?? null,
              { method: path.endsWith("totp") ? "totp" : "backup_code", code: errorCode(returned) },
              ip,
              ua,
            );
            return;
          }
          const newSession = ctx.context.newSession;
          const current = newSession ?? (await getSessionFromCtx(ctx).catch(() => null));
          if (!current) return;
          await db
            .update(authSessions)
            .set({ twoFactorVerifiedAt: new Date() })
            .where(eq(authSessions.token, current.session.token));
          const userId = current.user.id;
          if (path.endsWith("backup-code"))
            await audit("auth.two_factor_recovery_code_used", userId, {}, ip, ua);
          if (enrollment) {
            // Sessions created before 2FA existed never passed a second factor: sign them out.
            await db
              .delete(authSessions)
              .where(
                and(eq(authSessions.userId, userId), ne(authSessions.token, current.session.token)),
              );
            await audit("auth.two_factor_enabled", userId, {}, ip, ua);
            await sendSecurityEmail("twoFactorEnabled", userId);
          } else {
            await audit(
              "auth.two_factor_verified",
              userId,
              { method: path.endsWith("totp") ? "totp" : "backup_code" },
              ip,
              ua,
            );
          }
          return;
        }

        const session = failed ? null : await getSessionFromCtx(ctx).catch(() => null);
        if (!session || failed) return;
        const userId = session.user.id;
        if (path === "/two-factor/disable") {
          await audit("auth.two_factor_disabled", userId, {}, ip, ua);
          await sendSecurityEmail("twoFactorDisabled", userId, {
            link: accountLink(
              String((session.user as { locale?: string }).locale ?? "en"),
              "/forgot-password",
            ),
          });
        } else if (path === "/two-factor/generate-backup-codes") {
          await audit("auth.two_factor_recovery_codes_regenerated", userId, {}, ip, ua);
        } else if (path === "/two-factor/enable") {
          await audit("auth.two_factor_enrollment_started", userId, {}, ip, ua);
        } else if (path === "/change-password") {
          await audit("auth.password_changed", userId, { otherSessionsRevoked: true }, ip, ua);
          await sendSecurityEmail("passwordChanged", userId, {
            link: accountLink(
              String((session.user as { locale?: string }).locale ?? "en"),
              "/forgot-password",
            ),
          });
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Housekeeping helper for tests/maintenance: active sessions of a user (newest first). */
export async function activeSessionCount(db: Database, userId: string): Promise<number> {
  return db.$count(
    authSessions,
    and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())),
  );
}
