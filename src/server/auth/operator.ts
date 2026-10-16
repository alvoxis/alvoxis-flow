import { eq } from "drizzle-orm";
import {
  parseEnvelope,
  type SecretConfig,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import { type ServerEnv } from "@/config/env";
import { recordAudit } from "@/server/audit/audit-log";
import type { Database } from "@/server/db/client";
import { authSessions, twoFactors, twoFactorUsedCodes, users } from "@/server/db/schema";
import { asLocale, authEmail } from "@/server/notifications/auth-emails";
import { type Mailer } from "@/server/notifications/mailer";

export interface OperatorTwoFactorResetInput {
  email: string;
  /** Ticket reference and how the identity was verified. */
  reason: string;
  /** Name of the person running the reset (recorded in the audit log). */
  operator: string;
}

export interface OperatorTwoFactorResetResult {
  userId: string;
  revokedSessions: number;
  /** Whether the account owner was told by email (detects social-engineered resets). */
  notified: boolean;
}

/**
 * Operator-only recovery for a user who lost both the authenticator and all recovery codes.
 * Run it ONLY after verifying the person's identity out of band. It removes the TOTP secret and
 * recovery codes, signs the user out everywhere and emails the account address. Owners and
 * admins are still required to enrol again: every company API stays blocked until they do.
 */
export async function operatorResetTwoFactor(
  db: Database,
  mailer: Mailer,
  input: OperatorTwoFactorResetInput,
  appUrl: string,
): Promise<OperatorTwoFactorResetResult | null> {
  const reason = input.reason.trim();
  const operator = input.operator.trim();
  if (reason.length < 5) throw new Error("A reason (ticket reference) is required");
  if (operator.length < 2) throw new Error("The operator's name is required");

  const reset = await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, locale: users.locale, name: users.displayName })
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()));
    if (!user) return null;
    await tx.delete(twoFactors).where(eq(twoFactors.userId, user.id));
    await tx.delete(twoFactorUsedCodes).where(eq(twoFactorUsedCodes.userId, user.id));
    await tx.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, user.id));
    const revoked = await tx
      .delete(authSessions)
      .where(eq(authSessions.userId, user.id))
      .returning({ id: authSessions.id });
    return { user, revokedSessions: revoked.length };
  });
  if (!reset) return null;

  const locale = asLocale(reset.user.locale);
  const delivery = await mailer
    .send(
      authEmail("twoFactorDisabled", reset.user.email, locale, {
        name: reset.user.name,
        link: `${appUrl.replace(/\/$/, "")}/${locale}/forgot-password`,
      }),
    )
    .catch(() => ({ status: "failed" as const }));
  const notified = delivery.status === "sent";

  await recordAudit(db, {
    companyId: null,
    actorUserId: null,
    action: "auth.two_factor_reset_by_operator",
    entityType: "user",
    entityId: reset.user.id,
    metadata: { reason, operator, revokedSessions: reset.revokedSessions, notified },
  });
  return { userId: reset.user.id, revokedSessions: reset.revokedSessions, notified };
}

/** Key material exactly as the auth library builds it from the validated env. */
export function secretConfigFromEnv(env: ServerEnv): SecretConfig | string {
  if (!env.BETTER_AUTH_SECRETS) return env.BETTER_AUTH_SECRET;
  return {
    keys: new Map(env.BETTER_AUTH_SECRETS.map((s) => [s.version, s.value])),
    currentVersion: env.BETTER_AUTH_SECRETS[0]!.version,
    legacySecret: env.BETTER_AUTH_SECRET,
  };
}

/**
 * After adding a new key to BETTER_AUTH_SECRETS, re-encrypts every TOTP secret and recovery-code
 * set with the current key so older keys can be retired. Idempotent; rows already on the
 * current version are skipped. Rows that cannot be decrypted are reported, never modified.
 */
export async function reencryptTwoFactorData(
  db: Database,
  key: SecretConfig,
): Promise<{ updated: number; skipped: number; unreadable: string[] }> {
  const rows = await db.select().from(twoFactors);
  let updated = 0;
  let skipped = 0;
  const unreadable: string[] = [];
  const isCurrent = (value: string) => parseEnvelope(value)?.version === key.currentVersion;
  for (const row of rows) {
    if (isCurrent(row.secret) && isCurrent(row.backupCodes)) {
      skipped++;
      continue;
    }
    try {
      const secret = await symmetricEncrypt({
        key,
        data: await symmetricDecrypt({ key, data: row.secret }),
      });
      const backupCodes = await symmetricEncrypt({
        key,
        data: await symmetricDecrypt({ key, data: row.backupCodes }),
      });
      await db.update(twoFactors).set({ secret, backupCodes }).where(eq(twoFactors.id, row.id));
      updated++;
    } catch {
      unreadable.push(row.userId);
    }
  }
  return { updated, skipped, unreadable };
}
