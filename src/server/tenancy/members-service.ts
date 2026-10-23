import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { memberships, roles, users } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { RecordNotFoundError, RecordStateError } from "@/server/records/errors";

/**
 * Members of a company and their roles (members.view to read, members.manage to change). Rules:
 * nobody changes their own membership; only an owner may give or take the owner role or change
 * an owner; the last active owner always stays an active owner. Owners and administrators must
 * use two-factor authentication, which requireCompanyAccess enforces on their next request.
 */

export interface MemberView {
  membershipId: string;
  email: string;
  displayName: string | null;
  roleKey: string;
  roleName: string;
  status: "invited" | "active" | "suspended";
  isSelf: boolean;
}

export interface RoleOption {
  key: string;
  name: string;
}

/** Members by email (members.view). */
export async function listMembers(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<{ members: MemberView[]; roles: RoleOption[] }> {
  await requireCompanyAccess(db, actor, companyId, "members.view");
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      email: users.email,
      displayName: users.displayName,
      roleKey: roles.key,
      roleName: roles.name,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, and(eq(roles.id, memberships.roleId), eq(roles.companyId, companyId)))
    .where(eq(memberships.companyId, companyId))
    .orderBy(asc(users.email));
  const roleRows = await db
    .select({ key: roles.key, name: roles.name })
    .from(roles)
    .where(eq(roles.companyId, companyId))
    .orderBy(asc(roles.isSystem), asc(roles.name));
  return {
    members: rows.map(({ userId, ...r }) => ({ ...r, isSelf: userId === actor.userId })),
    roles: roleRows,
  };
}

const updateSchema = z
  .strictObject({
    roleKey: z.string().max(100).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .refine((v) => v.roleKey !== undefined || v.status !== undefined);

/**
 * Changes a member's role and/or suspends or reactivates them (members.manage). Own membership →
 * 403; the owner role and owners only by an owner (403); the last active owner → 409
 * invalid_state member.lastOwner; unknown member or role → 404.
 */
export async function updateMember(
  db: Database,
  actor: Actor,
  companyId: string,
  membershipId: string,
  input: unknown,
): Promise<MemberView> {
  return db.transaction(async (tx) => {
    const ctx = await requireCompanyAccess(tx, actor, companyId, "members.manage");
    const data = updateSchema.parse(input);
    // Lock every membership of the company: concurrent changes cannot remove the last owner.
    const all = await tx
      .select({
        id: memberships.id,
        userId: memberships.userId,
        status: memberships.status,
        roleKey: roles.key,
      })
      .from(memberships)
      .innerJoin(roles, and(eq(roles.id, memberships.roleId), eq(roles.companyId, companyId)))
      .where(eq(memberships.companyId, companyId))
      .for("update", { of: memberships });
    const target = all.find((m) => m.id === membershipId);
    if (!target) throw new RecordNotFoundError();
    if (target.userId === actor.userId) throw new ForbiddenError("Own membership");
    const actorIsOwner = ctx.roleKey === "owner";
    let roleId: string | undefined;
    if (data.roleKey !== undefined) {
      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.companyId, companyId), eq(roles.key, data.roleKey)));
      if (!role) throw new RecordNotFoundError();
      roleId = role.id;
    }
    const touchesOwner = target.roleKey === "owner" || data.roleKey === "owner";
    if (touchesOwner && !actorIsOwner) throw new ForbiddenError("Only owners manage owners");
    const nextRole = data.roleKey ?? target.roleKey;
    const nextStatus = data.status ?? target.status;
    const otherActiveOwners = all.filter(
      (m) => m.id !== target.id && m.roleKey === "owner" && m.status === "active",
    ).length;
    if (
      target.roleKey === "owner" &&
      target.status === "active" &&
      (nextRole !== "owner" || nextStatus !== "active") &&
      otherActiveOwners === 0
    )
      throw new RecordStateError("member.lastOwner");
    await tx
      .update(memberships)
      .set({ ...(roleId ? { roleId } : {}), status: nextStatus })
      .where(and(eq(memberships.id, membershipId), eq(memberships.companyId, companyId)));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "member.updated",
      entityType: "membership",
      entityId: membershipId,
      metadata: {
        ...(data.roleKey !== undefined ? { fromRole: target.roleKey, toRole: nextRole } : {}),
        ...(data.status !== undefined ? { fromStatus: target.status, toStatus: nextStatus } : {}),
      },
    });
    const { members } = await listMembers(tx, actor, companyId);
    return members.find((m) => m.membershipId === membershipId)!;
  });
}

/** What the settings page may show (any member): which sections their role can open. */
export async function settingsAccess(db: DbOrTx, actor: Actor, companyId: string) {
  const ctx = await requireCompanyAccess(db, actor, companyId);
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(ctx, p);
  return {
    roleKey: ctx.roleKey,
    profile: can("company.view"),
    taxCategories: can("documents.view"),
    bankAccounts: can("documents.view"),
    warehouses: can("inventory.view"),
    payrollRates: can("payroll.view"),
    members: can("members.view"),
    manageMembers: can("members.manage"),
  };
}
