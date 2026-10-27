import "server-only";
import { and, count, desc, eq, gte, ilike, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { PLAN } from "@/modules/billing/plans";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import {
  aiUsage,
  auditLogs,
  companies,
  companyAccessGrants,
  companyBilling,
  memberships,
  platformAdmins,
  users,
} from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { RecordNotFoundError } from "@/server/records/errors";

/**
 * The SaaS operator's area. Access needs a row in platform_admins (granted only by the operator
 * script, never through the web application or from client data) AND a session that passed
 * two-factor authentication. Anything else gets the same ForbiddenError as a missing company, so
 * the area does not reveal itself. Every operator action is audited; views show aggregates and
 * company names, not customers' business data or personal details beyond what is needed.
 */

export async function requirePlatformAdmin(db: DbOrTx, actor: Actor): Promise<void> {
  const [row] = await db
    .select({
      userId: platformAdmins.userId,
      twoFactor: users.twoFactorEnabled,
      disabled: users.disabledAt,
    })
    .from(platformAdmins)
    .innerJoin(users, eq(users.id, platformAdmins.userId))
    .where(eq(platformAdmins.userId, actor.userId));
  if (!row || row.disabled || !row.twoFactor || !actor.twoFactorVerified)
    throw new ForbiddenError("Not a platform administrator");
}

export async function isPlatformAdmin(db: DbOrTx, actor: Actor): Promise<boolean> {
  try {
    await requirePlatformAdmin(db, actor);
    return true;
  } catch {
    return false;
  }
}

/** List prices of the default assistant model (USD per million tokens), for cost estimates. */
const AI_PRICE_PER_MTOK = { input: 4, output: 20 };

export async function adminOverview(
  db: Database,
  actor: Actor,
  config: { stripe: boolean; webhook: boolean; ai: boolean; email: string; enforcement: boolean },
) {
  await requirePlatformAdmin(db, actor);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const dbStart = Date.now();
  const [[usersRow], [companiesRow], statuses, [failures], [ai], events] = await Promise.all([
    db
      .select({
        total: count(),
        verified: sql<number>`count(*) filter (where ${users.emailVerified})`.mapWith(Number),
        new30: sql<number>`count(*) filter (where ${users.createdAt} >= ${since30})`.mapWith(
          Number,
        ),
      })
      .from(users),
    db
      .select({
        total: count(),
        new30: sql<number>`count(*) filter (where ${companies.createdAt} >= ${since30})`.mapWith(
          Number,
        ),
      })
      .from(companies)
      .where(isNull(companies.archivedAt)),
    db
      .select({ status: companyBilling.status, n: count() })
      .from(companyBilling)
      .groupBy(companyBilling.status),
    db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "billing.paymentFailed"), gte(auditLogs.createdAt, since30))),
    db
      .select({
        requests: count(),
        errors: sql<number>`count(*) filter (where ${aiUsage.status} <> 'ok')`.mapWith(Number),
        input: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)`.mapWith(Number),
        output: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)`.mapWith(Number),
        companies: sql<number>`count(distinct ${aiUsage.companyId})`.mapWith(Number),
      })
      .from(aiUsage)
      .where(gte(aiUsage.createdAt, monthStart)),
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        at: auditLogs.createdAt,
        company: companies.name,
      })
      .from(auditLogs)
      .leftJoin(companies, eq(companies.id, auditLogs.companyId))
      .where(
        sql`${auditLogs.action} like 'billing.%' or ${auditLogs.action} like 'admin.%' or ${auditLogs.action} like 'auth.two_factor_reset%'`,
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(20),
  ]);
  const dbLatencyMs = Date.now() - dbStart;
  const byStatus = Object.fromEntries(statuses.map((s) => [s.status ?? "none", s.n]));
  const active = (byStatus.active ?? 0) + (byStatus.trialing ?? 0);
  const estimatedCostUsd =
    ((ai?.input ?? 0) * AI_PRICE_PER_MTOK.input + (ai?.output ?? 0) * AI_PRICE_PER_MTOK.output) /
    1_000_000;
  await recordAudit(db, {
    companyId: null,
    actorUserId: actor.userId,
    action: "admin.overview_viewed",
  });
  return {
    users: {
      total: usersRow?.total ?? 0,
      verified: usersRow?.verified ?? 0,
      new30: usersRow?.new30 ?? 0,
    },
    companies: { total: companiesRow?.total ?? 0, new30: companiesRow?.new30 ?? 0 },
    subscriptions: {
      byStatus,
      active,
      pastDue: byStatus.past_due ?? 0,
      canceled: byStatus.canceled ?? 0,
      /** Active subscriptions × list price; Stripe holds the actual invoiced revenue. */
      monthlyAtListPriceEur: ((active * PLAN.amountCents) / 100).toFixed(2),
      paymentFailures30d: failures?.n ?? 0,
    },
    ai: {
      requestsThisMonth: ai?.requests ?? 0,
      errorsThisMonth: ai?.errors ?? 0,
      inputTokens: ai?.input ?? 0,
      outputTokens: ai?.output ?? 0,
      companies: ai?.companies ?? 0,
      estimatedCostUsd: estimatedCostUsd.toFixed(2),
    },
    health: { dbLatencyMs, ...config },
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      at: e.at.toISOString(),
      company: e.company,
    })),
  };
}

export async function adminCompanies(db: Database, actor: Actor, q?: string) {
  await requirePlatformAdmin(db, actor);
  const pattern = q?.trim()
    ? `%${q
        .trim()
        .slice(0, 100)
        .replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    : null;
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      country: companies.country,
      createdAt: companies.createdAt,
      archived: sql<boolean>`${companies.archivedAt} is not null`,
      members:
        sql<number>`(select count(*) from ${memberships} m where m.company_id = ${companies.id} and m.status = 'active')`.mapWith(
          Number,
        ),
      status: companyBilling.status,
      grantExpiresAt: companyAccessGrants.expiresAt,
    })
    .from(companies)
    .leftJoin(companyBilling, eq(companyBilling.companyId, companies.id))
    .leftJoin(companyAccessGrants, eq(companyAccessGrants.companyId, companies.id))
    .where(pattern ? ilike(companies.name, pattern) : undefined)
    .orderBy(desc(companies.createdAt))
    .limit(100);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    grantExpiresAt:
      r.grantExpiresAt && r.grantExpiresAt > new Date() ? r.grantExpiresAt.toISOString() : null,
  }));
}

const grantSchema = z.strictObject({
  days: z.number().int().min(1).max(90),
  reason: z.string().trim().min(5).max(300),
});

/** Grants (or replaces) time-limited internal access without a subscription. Audited. */
export async function grantInternalAccess(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
) {
  await requirePlatformAdmin(db, actor);
  const { days, reason } = grantSchema.parse(input);
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!c) throw new RecordNotFoundError();
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await tx
      .insert(companyAccessGrants)
      .values({ companyId, reason, grantedByUserId: actor.userId, expiresAt })
      .onConflictDoUpdate({
        target: companyAccessGrants.companyId,
        set: { reason, grantedByUserId: actor.userId, expiresAt, createdAt: new Date() },
      });
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "admin.access_granted",
      entityType: "company",
      entityId: companyId,
      metadata: { days, reason },
    });
    return { expiresAt: expiresAt.toISOString() };
  });
}

export async function revokeInternalAccess(db: Database, actor: Actor, companyId: string) {
  await requirePlatformAdmin(db, actor);
  await db.transaction(async (tx) => {
    const gone = await tx
      .delete(companyAccessGrants)
      .where(eq(companyAccessGrants.companyId, companyId))
      .returning({ id: companyAccessGrants.companyId });
    if (gone.length === 0) throw new RecordNotFoundError();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "admin.access_revoked",
      entityType: "company",
      entityId: companyId,
    });
  });
}

/** Operator script only: makes a user a platform administrator (or removes one). Audited. */
export async function setPlatformAdmin(
  db: Database,
  input: { email: string; operator: string; reason: string; revoke: boolean },
): Promise<"granted" | "revoked" | "unchanged" | "no_user"> {
  if (input.reason.trim().length < 5) throw new Error("A reason (ticket reference) is required");
  if (input.operator.trim().length < 2) throw new Error("The operator's name is required");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()));
    if (!u) return "no_user";
    const result = input.revoke
      ? (await tx.delete(platformAdmins).where(eq(platformAdmins.userId, u.id)).returning()).length
        ? "revoked"
        : "unchanged"
      : (
            await tx
              .insert(platformAdmins)
              .values({ userId: u.id, grantedBy: input.operator.trim() })
              .onConflictDoNothing()
              .returning()
          ).length
        ? "granted"
        : "unchanged";
    if (result !== "unchanged")
      await recordAudit(tx, {
        companyId: null,
        actorUserId: null,
        action: input.revoke ? "admin.platform_admin_revoked" : "admin.platform_admin_granted",
        entityType: "user",
        entityId: u.id,
        metadata: { operator: input.operator.trim(), reason: input.reason.trim() },
      });
    return result;
  });
}
