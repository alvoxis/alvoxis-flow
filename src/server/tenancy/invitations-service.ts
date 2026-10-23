import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { companies, companyInvitations, memberships, roles, users } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { type Mailer } from "@/server/notifications/mailer";
import { invitationEmail } from "@/server/notifications/invitation-email";
import { asLocale } from "@/server/notifications/auth-emails";
import {
  RecordNotFoundError,
  RecordStateError,
  RecordTakenError,
  RecordValidationError,
} from "@/server/records/errors";

/**
 * Invitations to join a company (members.view to list, members.manage to invite or revoke). The
 * link carries a random token; only its SHA-256 hash is stored. Accepting needs a signed-in user
 * whose (verified) email equals the invited address; the membership is created active with the
 * invited role. The owner role is invited and revoked only by owners, as with member changes.
 * Audit entries never carry the invited address.
 */

export const INVITATION_DAYS = 7;

export interface InvitationView {
  id: string;
  email: string;
  roleKey: string;
  roleName: string;
  expiresAt: string;
  expired: boolean;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const open = and(isNull(companyInvitations.acceptedAt), isNull(companyInvitations.revokedAt));

/** Open invitations of the company, newest first (members.view). */
export async function listInvitations(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<InvitationView[]> {
  await requireCompanyAccess(db, actor, companyId, "members.view");
  const rows = await db
    .select({
      id: companyInvitations.id,
      email: companyInvitations.email,
      roleKey: roles.key,
      roleName: roles.name,
      expiresAt: companyInvitations.expiresAt,
    })
    .from(companyInvitations)
    .innerJoin(roles, and(eq(roles.id, companyInvitations.roleId), eq(roles.companyId, companyId)))
    .where(and(eq(companyInvitations.companyId, companyId), open))
    .orderBy(asc(companyInvitations.email));
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt.getTime() <= now,
  }));
}

const createSchema = z.strictObject({
  email: z.unknown(),
  roleKey: z.unknown(),
});
const emailSchema = z.email().max(254);

export interface CreatedInvitation {
  invitation: InvitationView;
  /** The link to share; shown once to the inviter (also emailed when email is configured). */
  link: string;
  delivery: "sent" | "not_configured" | "failed";
}

/**
 * Invites `email` with `roleKey` (members.manage). Invalid email or role → 422 with every issue;
 * an existing member → 409 member_exists; the owner role by a non-owner → 403. Inviting an address
 * that already has an open invitation replaces it (the old link stops working).
 */
export async function createInvitation(
  db: Database,
  mailer: Mailer,
  appUrl: string,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<CreatedInvitation> {
  const token = randomBytes(32).toString("base64url");
  const created = await db.transaction(async (tx) => {
    const ctx = await requireCompanyAccess(tx, actor, companyId, "members.manage");
    const raw = createSchema.parse(input);
    const issues: { code: string; severity: "error"; path: string }[] = [];
    const email = emailSchema.safeParse(
      typeof raw.email === "string" ? raw.email.trim().toLowerCase() : raw.email,
    );
    if (!email.success) issues.push({ code: "invalid_email", severity: "error", path: "email" });
    const [role] =
      typeof raw.roleKey === "string"
        ? await tx
            .select({ id: roles.id, key: roles.key, name: roles.name })
            .from(roles)
            .where(and(eq(roles.companyId, companyId), eq(roles.key, raw.roleKey)))
        : [];
    if (!role) issues.push({ code: "invalid_role", severity: "error", path: "roleKey" });
    if (!email.success || !role) throw new RecordValidationError(issues);
    if (role.key === "owner" && ctx.roleKey !== "owner")
      throw new ForbiddenError("Only owners invite owners");

    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, companyId), eq(users.email, email.data)));
    if (existing) throw new RecordTakenError("member_exists");

    // Serialise invitations for the same address so a replacement never races its predecessor.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`invitation:${companyId}:${email.data}`}))`,
    );
    await tx
      .update(companyInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(companyInvitations.companyId, companyId),
          eq(companyInvitations.email, email.data),
          open,
        ),
      );
    const expiresAt = new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000);
    const [row] = await tx
      .insert(companyInvitations)
      .values({
        companyId,
        email: email.data,
        roleId: role.id,
        tokenHash: hashToken(token),
        invitedBy: actor.userId,
        expiresAt,
      })
      .returning({ id: companyInvitations.id });
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "member.invited",
      entityType: "invitation",
      entityId: row!.id,
      metadata: { role: role.key },
    });
    const [names] = await tx
      .select({
        company: companies.name,
        inviter: users.displayName,
        inviterEmail: users.email,
        locale: users.locale,
      })
      .from(companies)
      .innerJoin(users, eq(users.id, actor.userId))
      .where(eq(companies.id, companyId));
    return {
      invitation: {
        id: row!.id,
        email: email.data,
        roleKey: role.key,
        roleName: role.name,
        expiresAt: expiresAt.toISOString(),
        expired: false,
      },
      company: names!.company,
      inviter: names!.inviter?.trim() || names!.inviterEmail,
      locale: asLocale(names!.locale),
    };
  });

  const link = `${appUrl.replace(/\/$/, "")}/${created.locale}/invitations/${token}`;
  const result = await mailer.send(
    invitationEmail(created.invitation.email, created.locale, {
      company: created.company,
      inviter: created.inviter,
      link,
      days: INVITATION_DAYS,
    }),
  );
  return { invitation: created.invitation, link, delivery: result.status };
}

/** Revokes an open invitation (members.manage; owner-role invitations only by owners). */
export async function revokeInvitation(
  db: Database,
  actor: Actor,
  companyId: string,
  invitationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await requireCompanyAccess(tx, actor, companyId, "members.manage");
    const [row] = await tx
      .select({ id: companyInvitations.id, roleKey: roles.key })
      .from(companyInvitations)
      .innerJoin(roles, eq(roles.id, companyInvitations.roleId))
      .where(
        and(
          eq(companyInvitations.id, invitationId),
          eq(companyInvitations.companyId, companyId),
          open,
        ),
      )
      .for("update", { of: companyInvitations });
    if (!row) throw new RecordNotFoundError();
    if (row.roleKey === "owner" && ctx.roleKey !== "owner")
      throw new ForbiddenError("Only owners manage owners");
    await tx
      .update(companyInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(companyInvitations.id, invitationId));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "member.invitationRevoked",
      entityType: "invitation",
      entityId: invitationId,
    });
  });
}

export type InvitationLookup =
  | {
      status: "open";
      companyName: string;
      roleKey: string;
      roleName: string;
      /** The signed-in user's address matches the invitation. */
      emailMatches: boolean;
      /** The signed-in user is already a member of the company. */
      alreadyMember: boolean;
    }
  | { status: "expired" | "used" | "not_found" };

/**
 * What the invitation page shows to a signed-in user. Nothing about the company is revealed for an
 * unknown, used or expired token, and the invited address itself is never returned.
 */
export async function lookupInvitation(
  db: DbOrTx,
  userId: string,
  token: string,
): Promise<InvitationLookup> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { status: "not_found" };
  const [row] = await db
    .select({
      companyId: companyInvitations.companyId,
      email: companyInvitations.email,
      expiresAt: companyInvitations.expiresAt,
      acceptedAt: companyInvitations.acceptedAt,
      revokedAt: companyInvitations.revokedAt,
      companyName: companies.name,
      companyArchived: companies.archivedAt,
      roleKey: roles.key,
      roleName: roles.name,
    })
    .from(companyInvitations)
    .innerJoin(companies, eq(companies.id, companyInvitations.companyId))
    .innerJoin(roles, eq(roles.id, companyInvitations.roleId))
    .where(eq(companyInvitations.tokenHash, hashToken(token)));
  if (!row || row.companyArchived) return { status: "not_found" };
  if (row.acceptedAt || row.revokedAt) return { status: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [member] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.companyId, row.companyId), eq(memberships.userId, userId)));
  return {
    status: "open",
    companyName: row.companyName,
    roleKey: row.roleKey,
    roleName: row.roleName,
    emailMatches: user?.email === row.email,
    alreadyMember: Boolean(member),
  };
}

/**
 * Accepts an invitation for the signed-in user. Unknown token → 404; used, revoked or expired →
 * 409 invalid_state invitation.closed; another address → 409 invitation.otherEmail; already a
 * member → 409 invitation.alreadyMember. Returns the company id.
 */
export async function acceptInvitation(
  db: Database,
  userId: string,
  token: string,
): Promise<{ companyId: string }> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new RecordNotFoundError();
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(companyInvitations)
      .where(eq(companyInvitations.tokenHash, hashToken(token)))
      .for("update");
    if (!inv) throw new RecordNotFoundError();
    const [company] = await tx
      .select({ archivedAt: companies.archivedAt })
      .from(companies)
      .where(eq(companies.id, inv.companyId));
    if (!company || company.archivedAt) throw new RecordNotFoundError();
    if (inv.acceptedAt || inv.revokedAt || inv.expiresAt.getTime() <= Date.now())
      throw new RecordStateError("invitation.closed");
    const [user] = await tx
      .select({ email: users.email, verified: users.emailVerified, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!user || !user.verified || user.disabledAt) throw new ForbiddenError("User not eligible");
    if (user.email !== inv.email) throw new RecordStateError("invitation.otherEmail");
    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.companyId, inv.companyId), eq(memberships.userId, userId)));
    if (existing) throw new RecordStateError("invitation.alreadyMember");
    const [membership] = await tx
      .insert(memberships)
      .values({ companyId: inv.companyId, userId, roleId: inv.roleId, status: "active" })
      .returning({ id: memberships.id });
    await tx
      .update(companyInvitations)
      .set({ acceptedAt: new Date(), acceptedBy: userId })
      .where(eq(companyInvitations.id, inv.id));
    await recordAudit(tx, {
      companyId: inv.companyId,
      actorUserId: userId,
      action: "member.invitationAccepted",
      entityType: "membership",
      entityId: membership!.id,
      metadata: { invitationId: inv.id },
    });
    return { companyId: inv.companyId };
  });
}
