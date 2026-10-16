import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { and, eq, gt, inArray, lt, notInArray, sql } from "drizzle-orm";
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
import { storedTokenCandidates, withHashedSessionTokens } from "./session-token-store";
import { userRequiresTwoFactor } from "./two-factor-policy";
import { deviceLabel } from "./user-agent";

export const AUTH_BASE_PATH = "/api/auth";
export const SESSION_EXPIRES_IN = 60 * 60 * 24 * 7; // 7 days
export const SESSION_UPDATE_AGE = 60 * 60; // refresh (and record activity) at most hourly
export const PASSWORD_MIN_LENGTH = 12;
export const RESET_TOKEN_EXPIRES_IN = 60 * 60; // 1 hour
const TOTP_REPLAY_WINDOW_SECONDS = 120; // covers the ±1 step tolerance of a 30s TOTP
/** Failed password sign-ins per account (any IP) before further attempts are refused. */
export const ACCOUNT_SIGN_IN_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
/**
 * A browser that has signed in to an account with the correct password before carries a signed
 * "known device" cookie for it. While the account's limit is exhausted only such browsers may keep
 * trying (password, 2FA and per-IP limits still apply), so an attacker cannot lock the owner out.
 */
const KNOWN_DEVICE_COOKIE = "known_device";
const KNOWN_DEVICE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days
const KNOWN_DEVICE_MAX_ACCOUNTS = 5;

/**
 * Endpoints a session that still owes its second factor may call. Everything else that acts on the
 * current session (reading the TOTP URI, regenerating recovery codes, changing the password or
 * profile, linking accounts…) is refused until the challenge is passed. Without this, a session
 * created by Google sign-in — which the 2FA plugin does not intercept — could read the TOTP secret.
 */
const PENDING_TWO_FACTOR_ALLOWED = [
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/get-session",
  "/sign-out",
];
/** Endpoints that do not act on an existing session (starting a new sign-in, email links). */
const SESSIONLESS_PREFIXES = [
  "/sign-in/",
  "/sign-up/",
  "/callback/",
  "/request-password-reset",
  "/reset-password",
  "/verify-email",
  "/send-verification-email",
  "/error",
  "/ok",
];

export interface AuthDeps {
  db: Database;
  env: ServerEnv;
  mailer: Mailer;
}

/** Errors this app adds on top of the library's error codes (translated in the UI). */
export const APP_AUTH_ERRORS = {
  TWO_FACTOR_REQUIRED_FOR_ROLE: "TWO_FACTOR_REQUIRED_FOR_ROLE",
  TWO_FACTOR_CHALLENGE_REQUIRED: "TWO_FACTOR_CHALLENGE_REQUIRED",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
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

export const DISABLED_AUTH_PATHS = [
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/two-factor/get-totp-uri",
  "/delete-user",
  "/delete-user/callback",
  "/update-user",
  "/update-session",
  "/change-email",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
  "/verify-password",
];

/** Enrollment state detected in the before-hook, consumed by the after-hook of the same request. */
const enrollmentRequests = new WeakSet<Request>();
/** 2FA verification time of the session that requested a password change (copied to its replacement). */
const passwordChangeVerification = new WeakMap<Request, Date | null>();

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
            // A Google account whose address Google has not verified gets no session.
            requireEmailVerification: true,
          },
        }
      : {};
  const accountLink = (locale: string, path: string) => `${appUrl}/${asLocale(locale)}${path}`;

  const hashCode = (userId: string, code: string) =>
    createHmac("sha256", env.BETTER_AUTH_SECRET)
      .update(`totp:${userId}:${code}`)
      .digest("base64url");

  const accountKey = (email: string) =>
    `sign-in-account:${createHmac("sha256", env.BETTER_AUTH_SECRET)
      .update(email.trim().toLowerCase())
      .digest("base64url")}`;
  /** Short account identifier stored in the known-device cookie (no email address in cookies). */
  const knownDeviceId = (email: string) => accountKey(email).slice("sign-in-account:".length, 38);
  const clearAccountFailures = (email: string) =>
    db.delete(authRateLimits).where(eq(authRateLimits.key, accountKey(email)));

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
    // Explicit so key rotation is configured only through the validated env (the library would
    // otherwise read process.env.BETTER_AUTH_SECRETS on its own).
    secrets: env.BETTER_AUTH_SECRETS,
    trustedOrigins: [appUrl],
    telemetry: { enabled: false },
    logger: { level: env.LOG_LEVEL === "debug" ? "debug" : "warn" },
    // Session tokens are stored as SHA-256 digests (see session-token-store.ts).
    database: withHashedSessionTokens(
      drizzleAdapter(db, {
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
    ),
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
      ipAddress: {
        ipAddressHeaders: env.TRUSTED_IP_HEADER ? [env.TRUSTED_IP_HEADER] : [],
        trustedProxies: env.TRUSTED_PROXIES,
      },
      // The library skips origin/callbackURL validation when NODE_ENV=test; keep it on everywhere.
      disableOriginCheck: false,
    },
    // Only endpoints the app uses stay reachable. Session management goes through the app's
    // audited service (no tokens sent to browsers); email/SMS one-time codes are not offered;
    // the TOTP URI is shown once at enrolment and can never be read again; profile/email
    // changes, account linking and provider tokens are not features yet.
    disabledPaths: DISABLED_AUTH_PATHS,
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
        await clearAccountFailures(user.email);
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
            // Disabled or unverified users cannot obtain sessions by any method (password, Google, 2FA).
            if (!user || user.disabledAt || !user.emailVerified) return false;
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

        // A session of a 2FA user that has not passed the second factor may only complete it.
        if (
          !PENDING_TWO_FACTOR_ALLOWED.includes(path) &&
          !SESSIONLESS_PREFIXES.some((prefix) => path.startsWith(prefix))
        ) {
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          if (token) {
            const candidates = storedTokenCandidates(token);
            const [row] = await db
              .select({
                verifiedAt: authSessions.twoFactorVerifiedAt,
                twoFactorEnabled: users.twoFactorEnabled,
              })
              .from(authSessions)
              .innerJoin(users, eq(users.id, authSessions.userId))
              .where(inArray(authSessions.token, candidates.length ? candidates : ["-"]))
              .limit(1);
            if (row?.twoFactorEnabled && !row.verifiedAt) {
              throw new APIError("FORBIDDEN", {
                code: APP_AUTH_ERRORS.TWO_FACTOR_CHALLENGE_REQUIRED,
                message: "Complete two-factor authentication first",
              });
            }
          }
        }

        // Password guessing is limited per account as well as per IP, so spoofed or rotating
        // client IPs do not help. Unknown addresses are counted the same way (no enumeration).
        if (path === "/sign-in/email" && typeof body.email === "string") {
          const [entry] = await db
            .select()
            .from(authRateLimits)
            .where(eq(authRateLimits.key, accountKey(body.email)));
          const locked =
            entry &&
            entry.count >= ACCOUNT_SIGN_IN_LIMIT.max &&
            Date.now() - entry.lastRequest < ACCOUNT_SIGN_IN_LIMIT.windowMs;
          const knownDevice =
            locked &&
            String(
              (await ctx.getSignedCookie(
                ctx.context.createAuthCookie(KNOWN_DEVICE_COOKIE).name,
                ctx.context.secret,
              )) ?? "",
            )
              .split(",")
              .includes(knownDeviceId(body.email));
          if (locked && !knownDevice) {
            throw new APIError("TOO_MANY_REQUESTS", {
              code: APP_AUTH_ERRORS.TOO_MANY_ATTEMPTS,
              message: "Too many failed attempts. Try again later.",
            });
          }
        }

        if (path === "/change-password") {
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          if (token && ctx.request) {
            const [row] = await db
              .select({ verifiedAt: authSessions.twoFactorVerifiedAt })
              .from(authSessions)
              .where(inArray(authSessions.token, storedTokenCandidates(token)));
            passwordChangeVerification.set(ctx.request, row?.verifiedAt ?? null);
          }
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
        // Same resolution as rate limiting and sessions (trusted header/proxies only).
        const ip = ctx.request ? getIP(ctx.request, ctx.context.options) : null;
        const ua = ctx.request?.headers.get("user-agent") ?? null;

        if (path === "/sign-in/email") {
          const email =
            typeof (ctx.body as { email?: unknown })?.email === "string"
              ? String((ctx.body as { email: string }).email).toLowerCase()
              : null;
          if (email && failed && errorCode(returned) === "INVALID_EMAIL_OR_PASSWORD") {
            const now = Date.now();
            const expired = sql`${authRateLimits.lastRequest} < ${now - ACCOUNT_SIGN_IN_LIMIT.windowMs}`;
            const [counter] = await db
              .insert(authRateLimits)
              .values({ key: accountKey(email), count: 1, lastRequest: now })
              .onConflictDoUpdate({
                target: authRateLimits.key,
                set: {
                  count: sql`case when ${expired} then 1 else ${authRateLimits.count} + 1 end`,
                  lastRequest: sql`case when ${expired} then ${now} else ${authRateLimits.lastRequest} end`,
                },
              })
              .returning({ count: authRateLimits.count });
            if (counter?.count === ACCOUNT_SIGN_IN_LIMIT.max) {
              // Tell the owner once per lock (unknown addresses: nobody to tell, same response).
              const [owner] = await db
                .select({ id: users.id, locale: users.locale })
                .from(users)
                .where(eq(users.email, email))
                .limit(1);
              if (owner) {
                await audit("auth.sign_in_locked", owner.id, {}, ip, ua);
                await sendSecurityEmail("signInLocked", owner.id, {
                  link: accountLink(owner.locale, "/forgot-password"),
                });
              }
            }
          } else if (email && !failed) {
            await clearAccountFailures(email);
            // Correct password: remember this browser for the account (see KNOWN_DEVICE_COOKIE).
            const cookie = ctx.context.createAuthCookie(KNOWN_DEVICE_COOKIE, {
              maxAge: KNOWN_DEVICE_MAX_AGE,
            });
            const previous = String(
              (await ctx.getSignedCookie(cookie.name, ctx.context.secret)) ?? "",
            )
              .split(",")
              .filter((id) => id && id !== knownDeviceId(email));
            await ctx.setSignedCookie(
              cookie.name,
              [knownDeviceId(email), ...previous].slice(0, KNOWN_DEVICE_MAX_ACCOUNTS).join(","),
              ctx.context.secret,
              cookie.attributes,
            );
          }
          if (failed) {
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
            .where(inArray(authSessions.token, storedTokenCandidates(current.session.token)));
          const userId = current.user.id;
          if (path.endsWith("backup-code"))
            await audit("auth.two_factor_recovery_code_used", userId, {}, ip, ua);
          if (enrollment) {
            // Sessions created before 2FA existed never passed a second factor: sign them out.
            await db
              .delete(authSessions)
              .where(
                and(
                  eq(authSessions.userId, userId),
                  notInArray(authSessions.token, storedTokenCandidates(current.session.token)),
                ),
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

        if (path === "/change-password" && !failed && ctx.request && ctx.context.newSession) {
          // Revoking other sessions replaces the current one; it keeps its (possibly absent) 2FA
          // verification — never more than the session that made the request had.
          const verifiedAt = passwordChangeVerification.get(ctx.request) ?? null;
          passwordChangeVerification.delete(ctx.request);
          if (verifiedAt)
            await db
              .update(authSessions)
              .set({ twoFactorVerifiedAt: verifiedAt })
              .where(
                inArray(
                  authSessions.token,
                  storedTokenCandidates(ctx.context.newSession.session.token),
                ),
              );
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
