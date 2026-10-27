import { and, eq, isNull } from "drizzle-orm";
import {
  phaseOf,
  type SubscriptionAccess,
  subscriptionAccess,
  subscriptionEnforced,
  type SubscriptionPhase,
} from "@/modules/billing/access";
import { type DbOrTx } from "@/server/db/client";
import {
  companies,
  companyAccessGrants,
  companyBilling,
  memberships,
  rolePermissions,
  roles,
  users,
} from "@/server/db/schema";
import { ForbiddenError, SubscriptionRequiredError, TwoFactorRequiredError } from "@/server/errors";
import { isPermission, PAID_PERMISSIONS, type Permission } from "./permissions";

/**
 * The authenticated principal, as established by the session layer (later stage).
 * `twoFactorVerified` must reflect the *current session*, not merely the user's setting.
 */
export interface Actor {
  userId: string;
  twoFactorVerified: boolean;
}

/** Proven, server-side tenant context. Only obtainable through `requireCompanyAccess`. */
export interface CompanyContext {
  readonly companyId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly roleKey: string;
  /** Effective permissions: paid ones are withheld while the company is read-only. */
  readonly permissions: ReadonlySet<Permission>;
  readonly subscription: {
    readonly access: SubscriptionAccess;
    readonly phase: SubscriptionPhase;
    readonly enforced: boolean;
  };
}

/**
 * Loads the actor's active membership in `companyId`. Returns null when the user is not an
 * active member, the company is archived, or the user is disabled — callers must treat all
 * of these identically to avoid leaking whether a company exists.
 */
async function loadMembership(db: DbOrTx, userId: string, companyId: string) {
  const rows = await db
    .select({
      membershipId: memberships.id,
      roleId: roles.id,
      roleKey: roles.key,
      requiresTwoFactor: roles.requiresTwoFactor,
      billingStatus: companyBilling.status,
      grantExpiresAt: companyAccessGrants.expiresAt,
    })
    .from(memberships)
    .innerJoin(
      roles,
      and(eq(roles.id, memberships.roleId), eq(roles.companyId, memberships.companyId)),
    )
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(companyBilling, eq(companyBilling.companyId, memberships.companyId))
    .leftJoin(companyAccessGrants, eq(companyAccessGrants.companyId, memberships.companyId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.companyId, companyId),
        eq(memberships.status, "active"),
        isNull(companies.archivedAt),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Establishes a tenant context for the actor, optionally requiring a permission.
 * This is the single entry point for tenant-scoped server operations.
 */
export async function requireCompanyAccess(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  required?: Permission | readonly Permission[],
): Promise<CompanyContext> {
  const membership = await loadMembership(db, actor.userId, companyId);
  if (!membership) throw new ForbiddenError("No access to this company");

  if (membership.requiresTwoFactor && !actor.twoFactorVerified) {
    throw new TwoFactorRequiredError();
  }

  const permRows = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, membership.roleId));
  const granted = new Set(permRows.map((r) => r.key).filter(isPermission));

  const needed = required === undefined ? [] : typeof required === "string" ? [required] : required;
  const missing = needed.filter((p) => !granted.has(p));
  if (missing.length > 0) throw new ForbiddenError(`Missing permission: ${missing.join(", ")}`);

  // Subscription state is read on every request (no cache), so a payment or a cancellation applies
  // at once. Read-only companies keep every permission except the paid ones.
  const enforced = subscriptionEnforced();
  const access = subscriptionAccess({
    enforced,
    status: membership.billingStatus,
    grantExpiresAt: membership.grantExpiresAt,
  });
  if (access === "read_only") {
    if (needed.some((p) => PAID_PERMISSIONS.has(p))) throw new SubscriptionRequiredError();
    for (const p of PAID_PERMISSIONS) granted.delete(p);
  }

  return {
    companyId,
    userId: actor.userId,
    membershipId: membership.membershipId,
    roleKey: membership.roleKey,
    permissions: granted,
    subscription: { access, phase: phaseOf(membership.billingStatus), enforced },
  };
}

export function hasPermission(ctx: CompanyContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}
