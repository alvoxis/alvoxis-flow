import "server-only";
import { getServerEnv } from "@/config/env";
import { adminCompanies, adminOverview } from "@/modules/admin/server/admin-service";
import { subscriptionEnforced } from "@/modules/billing/access";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";

/** The operator area, or null for anyone who is not a platform admin with a 2FA session. */
export async function adminPageData(user: AuthenticatedUser, q?: string) {
  const env = getServerEnv();
  const db = getDb();
  try {
    const overview = await adminOverview(db, toActor(user), {
      stripe: Boolean(env.STRIPE_SECRET_KEY),
      webhook: Boolean(env.STRIPE_WEBHOOK_SECRET),
      ai: Boolean(env.ANTHROPIC_API_KEY),
      email: env.EMAIL_TRANSPORT,
      enforcement: subscriptionEnforced(),
    });
    const companies = await adminCompanies(db, toActor(user), q);
    return { overview, companies };
  } catch (err) {
    if (err instanceof ForbiddenError) return null;
    throw err;
  }
}
