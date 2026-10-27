import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminOverview,
  isPlatformAdmin,
  setPlatformAdmin,
} from "@/modules/admin/server/admin-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, companyAccessGrants, users } from "@/server/db/schema";
import { ForbiddenError, UnauthenticatedError } from "@/server/errors";
import { call, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * The operator area: only users granted by the operator script, with 2FA enabled and a 2FA
 * session, get in; company owners do not. Grants of internal access are audited. Synthetic data.
 */
const session = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: null as { userId: string; twoFactorVerified: boolean } | null,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/auth/instance", () => ({ getAuth: () => ({}) }));
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
const grantRoute = await import("@/app/api/admin/companies/[companyId]/access-grant/route");

let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  session.db = db;
});
afterAll(async () => pool.end());
beforeEach(() => {
  session.actor = null;
});
const h = routeHelpers(() => db);
const config = { stripe: false, webhook: false, ai: false, email: "file", enforcement: false };

describe("operator area", () => {
  it("admits only script-granted admins with 2FA, and audits grants", async () => {
    const owner = await h.newCompany("Klients SIA");
    const opUser = await h.newUser("operator");
    const op: Actor = { userId: opUser.id, twoFactorVerified: true };

    // A company owner is not an operator.
    expect(await isPlatformAdmin(db, owner.owner)).toBe(false);
    await expect(adminOverview(db, owner.owner, config)).rejects.toBeInstanceOf(ForbiddenError);

    expect(
      await setPlatformAdmin(db, {
        email: opUser.email,
        operator: "Test Op",
        reason: "TICKET-1",
        revoke: false,
      }),
    ).toBe("granted");
    expect(
      await setPlatformAdmin(db, {
        email: "nobody@example.test",
        operator: "Test Op",
        reason: "TICKET-1",
        revoke: false,
      }),
    ).toBe("no_user");
    await expect(
      setPlatformAdmin(db, { email: opUser.email, operator: "Op", reason: "x", revoke: false }),
    ).rejects.toThrow();
    // Granted, but without 2FA: still refused.
    expect(await isPlatformAdmin(db, op)).toBe(false);
    await db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, opUser.id));
    expect(await isPlatformAdmin(db, { ...op, twoFactorVerified: false })).toBe(false);
    expect(await isPlatformAdmin(db, op)).toBe(true);

    const o = await adminOverview(db, op, config);
    expect(o.users.total).toBeGreaterThan(0);
    expect(o.subscriptions).toMatchObject({
      monthlyAtListPriceEur: expect.stringMatching(/^\d+\.\d{2}$/),
    });

    session.actor = owner.owner;
    expect(
      (
        await call(
          grantRoute.POST(
            req("POST", { days: 7, reason: "QA run" }),
            params({ companyId: owner.companyId }),
          ),
        )
      ).status,
    ).toBe(403);
    session.actor = op;
    expect(
      (
        await call(
          grantRoute.POST(
            req("POST", { days: 365, reason: "QA run" }),
            params({ companyId: owner.companyId }),
          ),
        )
      ).status,
    ).toBe(422);
    const granted = await call(
      grantRoute.POST(
        req("POST", { days: 7, reason: "QA run 42" }),
        params({ companyId: owner.companyId }),
      ),
    );
    expect(granted.status).toBe(200);
    expect(
      await db
        .select()
        .from(companyAccessGrants)
        .where(eq(companyAccessGrants.companyId, owner.companyId)),
    ).toHaveLength(1);
    expect(
      (await call(grantRoute.DELETE(req("DELETE"), params({ companyId: owner.companyId })))).body,
    ).toEqual({ revoked: true });
    const audit = await db
      .select({ action: auditLogs.action, actor: auditLogs.actorUserId })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, owner.companyId)));
    expect(
      audit.filter((a) => a.action.startsWith("admin.")).map((a) => [a.action, a.actor]),
    ).toEqual([
      ["admin.access_granted", opUser.id],
      ["admin.access_revoked", opUser.id],
    ]);

    expect(
      await setPlatformAdmin(db, {
        email: opUser.email,
        operator: "Test Op",
        reason: "TICKET-2",
        revoke: true,
      }),
    ).toBe("revoked");
    expect(await isPlatformAdmin(db, op)).toBe(false);
  });
});
