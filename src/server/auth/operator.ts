import { eq } from "drizzle-orm";
import { recordAudit } from "@/server/audit/audit-log";
import type { Database } from "@/server/db/client";
import { authSessions, twoFactors, twoFactorUsedCodes, users } from "@/server/db/schema";

export interface OperatorTwoFactorResetResult {
  userId: string;
  revokedSessions: number;
}

/**
 * Operator-only recovery for a user who lost both the authenticator and all recovery codes.
 * Run it ONLY after verifying the person's identity out of band. It removes the TOTP secret and
 * recovery codes and signs the user out everywhere. Owners and admins are still required to
 * enrol again: the dashboard and every company API stay blocked until they do.
 */
export async function operatorResetTwoFactor(
  db: Database,
  email: string,
  reason: string,
): Promise<OperatorTwoFactorResetResult | null> {
  if (reason.trim().length < 5) throw new Error("A reason (ticket reference) is required");
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()));
    if (!user) return null;
    await tx.delete(twoFactors).where(eq(twoFactors.userId, user.id));
    await tx.delete(twoFactorUsedCodes).where(eq(twoFactorUsedCodes.userId, user.id));
    await tx.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, user.id));
    const revoked = await tx
      .delete(authSessions)
      .where(eq(authSessions.userId, user.id))
      .returning({ id: authSessions.id });
    await recordAudit(tx, {
      companyId: null,
      actorUserId: null,
      action: "auth.two_factor_reset_by_operator",
      entityType: "user",
      entityId: user.id,
      metadata: { reason: reason.trim(), revokedSessions: revoked.length },
    });
    return { userId: user.id, revokedSessions: revoked.length };
  });
}
