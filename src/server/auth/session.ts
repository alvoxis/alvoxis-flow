import { and, eq } from "drizzle-orm";
import { type Database } from "@/server/db/client";
import { authSessions, users } from "@/server/db/schema";
import { TwoFactorChallengeRequiredError, UnauthenticatedError } from "@/server/errors";
import { type Auth } from "./auth";
import { type Actor } from "./authorization";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  displayName: string | null;
  locale: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  sessionId: string;
  /** This session passed a second factor (TOTP or recovery code). */
  twoFactorVerified: boolean;
}

export interface RequireUserOptions {
  /** Allow sessions that still owe a 2FA challenge (only for the challenge page and sign-out). */
  allowPendingTwoFactor?: boolean;
}

/**
 * Resolves the current user from request headers and re-checks the database on every call:
 * the session must exist and be unexpired, the user must exist, not be disabled and have a
 * verified email address. Users with
 * 2FA enabled must have passed a second factor in THIS session.
 */
export async function requireUser(
  auth: Auth,
  db: Database,
  headers: Headers,
  options: RequireUserOptions = {},
): Promise<AuthenticatedUser> {
  const result = await auth.api
    .getSession({ headers, query: { disableCookieCache: true } })
    .catch(() => null);
  if (!result) throw new UnauthenticatedError();

  const [row] = await db
    .select({ user: users, session: authSessions })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, result.session.id), eq(authSessions.userId, result.user.id)))
    .limit(1);
  if (!row || row.session.expiresAt < new Date()) throw new UnauthenticatedError();
  if (row.user.disabledAt) {
    // A disabled user's sessions are removed as soon as they are seen.
    await db.delete(authSessions).where(eq(authSessions.userId, row.user.id));
    throw new UnauthenticatedError("Account disabled");
  }
  // Defence in depth: sessions are only issued to verified addresses; never honour one otherwise.
  if (!row.user.emailVerified) throw new UnauthenticatedError("Email address not verified");

  const twoFactorVerified = row.session.twoFactorVerifiedAt !== null;
  if (row.user.twoFactorEnabled && !twoFactorVerified && !options.allowPendingTwoFactor) {
    throw new TwoFactorChallengeRequiredError();
  }

  return {
    userId: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    locale: row.user.locale,
    emailVerified: row.user.emailVerified,
    twoFactorEnabled: row.user.twoFactorEnabled,
    sessionId: row.session.id,
    twoFactorVerified,
  };
}

/** Actor for `requireCompanyAccess`: 2FA state comes from the session, never from client input. */
export function toActor(user: AuthenticatedUser): Actor {
  return { userId: user.userId, twoFactorVerified: user.twoFactorVerified };
}
