import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/server/db/client";
import { TwoFactorChallengeRequiredError, UnauthenticatedError } from "@/server/errors";
import { getAuth } from "./instance";
import { type AuthenticatedUser, requireUser } from "./session";

type LoadResult =
  { user: AuthenticatedUser } | { user?: undefined; reason: "unauthenticated" | "two_factor" };

const load = cache(async (allowPendingTwoFactor: boolean): Promise<LoadResult> => {
  try {
    return {
      user: await requireUser(getAuth(), getDb(), await headers(), { allowPendingTwoFactor }),
    };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { reason: "unauthenticated" };
    if (err instanceof TwoFactorChallengeRequiredError) return { reason: "two_factor" };
    throw err;
  }
});

/** For pages: the signed-in user, or a redirect to sign-in / the 2FA challenge. */
export async function requirePageUser(locale: string, next?: string): Promise<AuthenticatedUser> {
  const r = await load(false);
  if (r.user) return r.user;
  if (r.reason === "two_factor") redirect(`/${locale}/two-factor`);
  redirect(`/${locale}/sign-in${next ? `?next=${encodeURIComponent(next)}` : ""}`);
}

/** For the 2FA challenge page: user (possibly pending) or null when not signed in. */
export async function optionalPageUser(): Promise<AuthenticatedUser | null> {
  const r = await load(true);
  return r.user ?? null;
}
