import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, companyInvitations, memberships, roles, users } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { type Mailer, MemoryMailer } from "@/server/notifications/mailer";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Member invitations over the real route handlers, services and database (only the session lookup,
 * the mailer and the public URL are stubbed): who may invite which role, validation, the emailed
 * link, accepting with the invited address only, revocation, expiry and replacement, isolation.
 * Synthetic addresses only (example.test); nothing is sent anywhere.
 */
const session = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: null as { userId: string; twoFactorVerified: boolean } | null,
  mailer: undefined as unknown,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({}),
  getMailer: () => session.mailer,
}));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServerEnv: () => ({ APP_URL: "https://app.example.test" }),
}));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => session.db,
}));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireUser: async () => {
    if (!session.actor) throw new UnauthenticatedError();
    return { ...session.actor, sessionId: "test-session" };
  },
}));

const listRoute = await import("@/app/api/companies/[companyId]/invitations/route");
const oneRoute = await import("@/app/api/companies/[companyId]/invitations/[invitationId]/route");
const acceptRoute = await import("@/app/api/invitations/accept/route");
const { lookupInvitation } = await import("@/server/tenancy/invitations-service");

let db: Database;
let pool: Pool;
let outbox: MemoryMailer;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  session.db = db;
});
afterAll(async () => pool.end());
beforeEach(() => {
  session.actor = null;
  outbox = new MemoryMailer();
  session.mailer = outbox;
});

const h = routeHelpers(() => db);
const as = (actor: Actor | null) => {
  session.actor = actor;
};
const api = {
  list: (companyId: string) => call(listRoute.GET(req("GET"), params({ companyId }))),
  invite: (companyId: string, body: unknown) =>
    call(listRoute.POST(req("POST", body), params({ companyId }))),
  revoke: (companyId: string, invitationId: string) =>
    call(oneRoute.DELETE(req("DELETE"), params({ companyId, invitationId }))),
  accept: (token: unknown) => call(acceptRoute.POST(req("POST", { token }))),
};
const tokenOf = (link: string) => link.split("/invitations/")[1]!;

/** A verified user with exactly `email` (the invitee signing up). */
async function userWithEmail(email: string) {
  const [u] = await db
    .insert(users)
    .values({ email, emailVerified: true, emailVerifiedAt: new Date() })
    .returning();
  return h.actorOf(u!.id);
}

const freshEmail = () => `invitee-${randomUUID()}@example.test`;

describe("member invitations", () => {
  it("invites by email, sends the link and lets only the invited address accept it", async () => {
    const c = await h.newCompany("Ielūgumi SIA");
    const email = freshEmail();
    as(c.owner);
    const created = await api.invite(c.companyId, {
      email: ` ${email.toUpperCase()} `,
      roleKey: "manager",
    });
    expect(created.status).toBe(201);
    expect(created.body.delivery).toBe("sent");
    expect(created.body.invitation).toMatchObject({ email, roleKey: "manager", expired: false });
    expect(created.body.link).toMatch(
      /^https:\/\/app\.example\.test\/en\/invitations\/[\w-]{40,}$/,
    );
    expect(outbox.outbox).toHaveLength(1);
    expect(outbox.outbox[0]).toMatchObject({ to: email, kind: "invitation" });
    expect(outbox.outbox[0]!.subject).toContain("Ielūgumi SIA");
    expect(outbox.outbox[0]!.text).toContain(created.body.link);

    // Only the hash is stored; the audit entry carries no address.
    const token = tokenOf(created.body.link);
    const [row] = await db
      .select()
      .from(companyInvitations)
      .where(eq(companyInvitations.id, created.body.invitation.id));
    expect(row!.tokenHash).not.toContain(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, c.companyId), eq(auditLogs.action, "member.invited")));
    expect(JSON.stringify(audits)).not.toContain(email);

    expect((await api.list(c.companyId)).body.invitations).toHaveLength(1);

    // Someone else signed in sees the company but cannot accept.
    const stranger = await userWithEmail(freshEmail());
    expect(await lookupInvitation(db, stranger.userId, token)).toMatchObject({
      status: "open",
      companyName: "Ielūgumi SIA",
      emailMatches: false,
    });
    as(stranger);
    expect((await api.accept(token)).body).toMatchObject({
      error: "invalid_state",
      code: "invitation.otherEmail",
    });

    const invitee = await userWithEmail(email);
    as(invitee);
    const accepted = await api.accept(token);
    expect(accepted).toMatchObject({ status: 200, body: { companyId: c.companyId } });
    const [m] = await db
      .select({ status: memberships.status, roleKey: roles.key })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.companyId, c.companyId), eq(memberships.userId, invitee.userId)));
    expect(m).toEqual({ status: "active", roleKey: "manager" });

    // The link works once; the invitation is no longer open.
    expect((await api.accept(token)).body).toMatchObject({ code: "invitation.closed" });
    expect(await lookupInvitation(db, invitee.userId, token)).toEqual({ status: "used" });
    as(c.owner);
    expect((await api.list(c.companyId)).body.invitations).toHaveLength(0);
    // The new member cannot be invited again.
    expect(await api.invite(c.companyId, { email, roleKey: "accountant" })).toMatchObject({
      status: 409,
      body: { error: "member_exists" },
    });
  });

  it("reports every invalid field and enforces who may invite which role", async () => {
    const c = await h.newCompany();
    as(c.owner);
    const bad = await api.invite(c.companyId, { email: "not-an-email", roleKey: "nope" });
    expect(bad.status).toBe(422);
    expect(issueCodes(bad.body)).toEqual(["invalid_email", "invalid_role"]);
    expect((await api.invite(c.companyId, { email: freshEmail() })).status).toBe(422);
    expect(
      (await api.invite(c.companyId, { email: freshEmail(), roleKey: "manager", x: 1 })).status,
    ).toBe(422);

    as(await h.member(c.companyId, "administrator"));
    expect((await api.invite(c.companyId, { email: freshEmail(), roleKey: "owner" })).status).toBe(
      403,
    );
    const byAdmin = await api.invite(c.companyId, { email: freshEmail(), roleKey: "accountant" });
    expect(byAdmin.status).toBe(201);

    as(c.owner);
    const ownerInvite = await api.invite(c.companyId, { email: freshEmail(), roleKey: "owner" });
    expect(ownerInvite.status).toBe(201);
    as(await h.member(c.companyId, "administrator"));
    expect((await api.revoke(c.companyId, ownerInvite.body.invitation.id)).status).toBe(403);

    // members.view lists but cannot invite or revoke.
    as(await h.member(c.companyId, "manager"));
    expect((await api.list(c.companyId)).body.invitations).toHaveLength(2);
    expect(
      (await api.invite(c.companyId, { email: freshEmail(), roleKey: "manager" })).status,
    ).toBe(403);
    expect((await api.revoke(c.companyId, byAdmin.body.invitation.id)).status).toBe(403);
    // Without members.view nothing is visible.
    as(await h.member(c.companyId, "warehouse_employee"));
    expect((await api.list(c.companyId)).status).toBe(403);
    as(null);
    expect((await api.list(c.companyId)).status).toBe(401);
    expect((await api.accept("x".repeat(43))).status).toBe(401);
  });

  it("revokes, expires and replaces invitations", async () => {
    const c = await h.newCompany();
    const email = freshEmail();
    const invitee = await userWithEmail(email);
    as(c.owner);
    const first = await api.invite(c.companyId, { email, roleKey: "manager" });
    const second = await api.invite(c.companyId, { email, roleKey: "accountant" });
    expect(second.status).toBe(201);
    // Replacing keeps one open invitation; the first link stops working.
    expect((await api.list(c.companyId)).body.invitations).toEqual([
      expect.objectContaining({ email, roleKey: "accountant" }),
    ]);
    as(invitee);
    expect((await api.accept(tokenOf(first.body.link))).body).toMatchObject({
      code: "invitation.closed",
    });

    as(c.owner);
    expect((await api.revoke(c.companyId, second.body.invitation.id)).status).toBe(200);
    expect((await api.revoke(c.companyId, second.body.invitation.id)).status).toBe(404);
    as(invitee);
    expect((await api.accept(tokenOf(second.body.link))).body).toMatchObject({
      code: "invitation.closed",
    });

    as(c.owner);
    const third = await api.invite(c.companyId, { email, roleKey: "manager" });
    await db
      .update(companyInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(companyInvitations.id, third.body.invitation.id));
    expect((await api.list(c.companyId)).body.invitations[0]).toMatchObject({ expired: true });
    as(invitee);
    expect(await lookupInvitation(db, invitee.userId, tokenOf(third.body.link))).toEqual({
      status: "expired",
    });
    expect((await api.accept(tokenOf(third.body.link))).body).toMatchObject({
      code: "invitation.closed",
    });
    expect((await api.accept("unknown-token-unknown-token-unknown")).status).toBe(404);
    expect((await api.accept("../../etc")).status).toBe(404);
    expect(await lookupInvitation(db, invitee.userId, "short")).toEqual({ status: "not_found" });
  });

  it("returns the link when email is not configured and isolates companies", async () => {
    const a = await h.newCompany("A SIA");
    const b = await h.newCompany("B SIA");
    session.mailer = {
      configured: false,
      transport: "disabled",
      send: async () => ({ status: "not_configured" }),
    } satisfies Mailer;
    as(a.owner);
    const created = await api.invite(a.companyId, { email: freshEmail(), roleKey: "manager" });
    expect(created.status).toBe(201);
    expect(created.body.delivery).toBe("not_configured");
    expect(created.body.link).toContain("/invitations/");

    as(b.owner);
    expect((await api.list(a.companyId)).status).toBe(403);
    expect((await api.revoke(a.companyId, created.body.invitation.id)).status).toBe(403);
    expect((await api.revoke(b.companyId, created.body.invitation.id)).status).toBe(404);
    expect((await api.list(b.companyId)).body.invitations).toEqual([]);
  });
});
