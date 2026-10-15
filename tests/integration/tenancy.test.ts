import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireCompanyAccess, type Actor } from "@/server/auth/authorization";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/server/auth/permissions";
import { type Database } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import {
  auditLogs,
  companies,
  memberships,
  permissions,
  rolePermissions,
  roles,
  users,
} from "@/server/db/schema";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import { createCompanyWithOwner, listCompaniesForUser } from "@/server/tenancy/company-service";
import { openTestDb, testDatabaseUrl } from "./test-db";

let db: Database;
let pool: Pool;

beforeAll(() => {
  ({ db, pool } = openTestDb());
});
afterAll(async () => {
  await pool.end();
});

async function createUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({ email: `user-${randomUUID()}@example.test`, ...overrides })
    .returning();
  return u!;
}

const verified = (userId: string): Actor => ({ userId, twoFactorVerified: true });

async function addMember(
  companyId: string,
  userId: string,
  roleKey: string,
  status: "active" | "suspended" = "active",
) {
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.key, roleKey)));
  await db.insert(memberships).values({ companyId, userId, roleId: role!.id, status });
}

describe("migrations", () => {
  it("are idempotent when re-applied", async () => {
    await expect(runMigrations(testDatabaseUrl())).resolves.toBeUndefined();
  });

  it("seeded the full permission catalog", async () => {
    const rows = await db.select().from(permissions);
    expect(rows.map((r) => r.key).sort()).toEqual([...PERMISSIONS].sort());
  });
});

describe("createCompanyWithOwner", () => {
  it("creates the company, system roles with template permissions, owner membership and audit entry", async () => {
    const owner = await createUser();
    const { companyId } = await createCompanyWithOwner(db, verified(owner.id), {
      name: " Acme SIA ",
      country: "LV",
    });

    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company!.name).toBe("Acme SIA");

    const companyRoles = await db.select().from(roles).where(eq(roles.companyId, companyId));
    expect(companyRoles.map((r) => r.key).sort()).toEqual(
      Object.keys(DEFAULT_ROLE_PERMISSIONS).sort(),
    );
    expect(
      companyRoles
        .filter((r) => r.requiresTwoFactor)
        .map((r) => r.key)
        .sort(),
    ).toEqual(["administrator", "owner"]);

    const accountant = companyRoles.find((r) => r.key === "accountant")!;
    const grants = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, accountant.id));
    expect(grants.map((g) => g.permissionKey).sort()).toEqual(
      [...DEFAULT_ROLE_PERMISSIONS.accountant].sort(),
    );

    const ctx = await requireCompanyAccess(db, verified(owner.id), companyId, "company.delete");
    expect(ctx.roleKey).toBe("owner");

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.companyId, companyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "company.created", actorUserId: owner.id });
  });

  it("rolls back completely when any step fails", async () => {
    const before = await db.$count(companies);
    // Non-existent user → membership FK violation after company and roles were inserted.
    await expect(
      createCompanyWithOwner(db, verified(randomUUID()), { name: "Ghost", country: "EE" }),
    ).rejects.toThrow();
    expect(await db.$count(companies)).toBe(before);
  });
});

describe("tenant isolation", () => {
  it("denies access to a company the user is not a member of, without revealing whether it exists", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { companyId: aliceCo } = await createCompanyWithOwner(db, verified(alice.id), {
      name: "Alice OÜ",
      country: "EE",
    });
    await createCompanyWithOwner(db, verified(bob.id), { name: "Bob UAB", country: "LT" });

    const err1 = await requireCompanyAccess(db, verified(bob.id), aliceCo).catch((e: unknown) => e);
    const err2 = await requireCompanyAccess(db, verified(bob.id), randomUUID()).catch(
      (e: unknown) => e,
    );
    expect(err1).toBeInstanceOf(ForbiddenError);
    expect(err2).toBeInstanceOf(ForbiddenError);
    expect((err1 as Error).message).toBe((err2 as Error).message);
  });

  it("lists only the user's own companies", async () => {
    const carol = await createUser();
    const dave = await createUser();
    await createCompanyWithOwner(db, verified(carol.id), {
      name: "Carol Sp. z o.o.",
      country: "PL",
    });
    const { companyId: daveCo } = await createCompanyWithOwner(db, verified(dave.id), {
      name: "Dave SIA",
      country: "LV",
    });

    const list = await listCompaniesForUser(db, carol.id);
    expect(list.map((c) => c.name)).toEqual(["Carol Sp. z o.o."]);
    expect(list.map((c) => c.id)).not.toContain(daveCo);
  });

  it("rejects, at the database level, a membership whose role belongs to another company", async () => {
    const u1 = await createUser();
    const u2 = await createUser();
    const { companyId: co1 } = await createCompanyWithOwner(db, verified(u1.id), {
      name: "One",
      country: "LV",
    });
    const { companyId: co2 } = await createCompanyWithOwner(db, verified(u2.id), {
      name: "Two",
      country: "LV",
    });
    const [foreignOwnerRole] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.companyId, co2), eq(roles.key, "owner")));

    const intruder = await createUser();
    await expect(
      db
        .insert(memberships)
        .values({ companyId: co1, userId: intruder.id, roleId: foreignOwnerRole!.id }),
    ).rejects.toThrow();
  });
});

describe("authorization", () => {
  it("enforces role permissions server-side", async () => {
    const owner = await createUser();
    const worker = await createUser();
    const { companyId } = await createCompanyWithOwner(db, verified(owner.id), {
      name: "Factory",
      country: "PL",
    });
    await addMember(companyId, worker.id, "warehouse_employee");

    const ctx = await requireCompanyAccess(db, verified(worker.id), companyId, "inventory.manage");
    expect(ctx.permissions.has("documents.approve")).toBe(false);
    await expect(
      requireCompanyAccess(db, verified(worker.id), companyId, "documents.approve"),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      requireCompanyAccess(db, verified(worker.id), companyId, [
        "inventory.view",
        "members.manage",
      ]),
    ).rejects.toThrow(/members.manage/);
  });

  it("requires a 2FA-verified session for owners and administrators only", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const accountant = await createUser();
    const { companyId } = await createCompanyWithOwner(db, verified(owner.id), {
      name: "Secure",
      country: "LT",
    });
    await addMember(companyId, admin.id, "administrator");
    await addMember(companyId, accountant.id, "accountant");

    for (const u of [owner, admin]) {
      await expect(
        requireCompanyAccess(db, { userId: u.id, twoFactorVerified: false }, companyId),
      ).rejects.toThrow(TwoFactorRequiredError);
    }
    await expect(
      requireCompanyAccess(
        db,
        { userId: accountant.id, twoFactorVerified: false },
        companyId,
        "documents.approve",
      ),
    ).resolves.toMatchObject({ roleKey: "accountant" });
  });

  it("denies suspended members, disabled users and archived companies", async () => {
    const owner = await createUser();
    const suspended = await createUser();
    const disabled = await createUser({ disabledAt: new Date() });
    const { companyId } = await createCompanyWithOwner(db, verified(owner.id), {
      name: "Gate",
      country: "EE",
    });
    await addMember(companyId, suspended.id, "manager", "suspended");
    await addMember(companyId, disabled.id, "manager");

    await expect(requireCompanyAccess(db, verified(suspended.id), companyId)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(requireCompanyAccess(db, verified(disabled.id), companyId)).rejects.toThrow(
      ForbiddenError,
    );

    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    await expect(requireCompanyAccess(db, verified(owner.id), companyId)).rejects.toThrow(
      ForbiddenError,
    );
    expect(await listCompaniesForUser(db, owner.id)).toEqual([]);
  });

  it("reflects per-company permission customisation without affecting other companies", async () => {
    const o1 = await createUser();
    const o2 = await createUser();
    const m1 = await createUser();
    const m2 = await createUser();
    const { companyId: c1 } = await createCompanyWithOwner(db, verified(o1.id), {
      name: "Custom",
      country: "LV",
    });
    const { companyId: c2 } = await createCompanyWithOwner(db, verified(o2.id), {
      name: "Default",
      country: "LV",
    });
    await addMember(c1, m1.id, "manager");
    await addMember(c2, m2.id, "manager");

    const [mgr1] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.companyId, c1), eq(roles.key, "manager")));
    await db
      .insert(rolePermissions)
      .values({ roleId: mgr1!.id, permissionKey: "documents.approve" });

    await expect(
      requireCompanyAccess(db, verified(m1.id), c1, "documents.approve"),
    ).resolves.toBeDefined();
    await expect(
      requireCompanyAccess(db, verified(m2.id), c2, "documents.approve"),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("data integrity", () => {
  it("makes audit logs append-only", async () => {
    const u = await createUser();
    await createCompanyWithOwner(db, verified(u.id), { name: "Audit", country: "PL" });
    const [entry] = await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, u.id));

    await expect(
      db.update(auditLogs).set({ action: "tampered" }).where(eq(auditLogs.id, entry!.id)),
    ).rejects.toThrow();
    await expect(db.delete(auditLogs).where(eq(auditLogs.id, entry!.id))).rejects.toThrow();
  });

  it("enforces lower-case, case-insensitively unique emails", async () => {
    await expect(db.insert(users).values({ email: "Mixed@Example.test" })).rejects.toThrow();
    const email = `dup-${randomUUID()}@example.test`;
    await db.insert(users).values({ email });
    await expect(db.insert(users).values({ email })).rejects.toThrow();
  });

  it("rejects permissions that are not in the catalog", async () => {
    const u = await createUser();
    const { companyId } = await createCompanyWithOwner(db, verified(u.id), {
      name: "Catalog",
      country: "EE",
    });
    const [role] = await db.select().from(roles).where(eq(roles.companyId, companyId)).limit(1);
    await expect(
      db.insert(rolePermissions).values({ roleId: role!.id, permissionKey: "made.up" }),
    ).rejects.toThrow();
  });
});
