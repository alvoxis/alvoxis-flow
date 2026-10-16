import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, companies, memberships, roles, users } from "@/server/db/schema";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import {
  getCompanyProfile,
  parseCompanyProfile,
  updateCompanyProfile,
} from "@/server/tenancy/company-profile";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { openTestDb } from "./test-db";

let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
});
afterAll(async () => pool.end());

const verified = (userId: string): Actor => ({ userId, twoFactorVerified: true });

async function createUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `profile-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function addMember(companyId: string, userId: string, roleKey: string) {
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.key, roleKey)));
  await db.insert(memberships).values({ companyId, userId, roleId: role!.id, status: "active" });
}

/** Synthetic company data only (no real registry or customer data). */
const PROFILE = {
  name: "Paraugs",
  legalName: "SIA Paraugs Testa Uzņēmums",
  registrationNumber: "40000000000",
  vatNumber: "lv 4000 0000 000",
  addressLine1: "Testa iela 1",
  addressLine2: "",
  postalCode: "LV-1000",
  city: "Rīga",
};

async function ownerCompany(country: "LV" | "LT" | "EE" | "PL" = "LV") {
  const owner = await createUser();
  const { companyId } = await createCompanyWithOwner(db, verified(owner.id), {
    name: "Profile Test",
    country,
  });
  return { owner, companyId };
}

describe("company profile", () => {
  it("owner reads and updates the profile; values are normalised and stored", async () => {
    const { owner, companyId } = await ownerCompany();
    const before = await getCompanyProfile(db, verified(owner.id), companyId);
    expect(before).toMatchObject({
      canEdit: true,
      profile: { name: "Profile Test", country: "LV", city: null },
    });

    const result = await updateCompanyProfile(db, verified(owner.id), companyId, PROFILE);
    expect(result).toMatchObject({
      ok: true,
      profile: {
        name: "Paraugs",
        legalName: "SIA Paraugs Testa Uzņēmums",
        registrationNumber: "40000000000",
        vatNumber: "LV40000000000",
        addressLine1: "Testa iela 1",
        addressLine2: null,
        postalCode: "LV-1000",
        city: "Rīga",
        country: "LV",
      },
    });
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row).toMatchObject({ vatNumber: "LV40000000000", city: "Rīga", country: "LV" });

    // Audit records which fields changed — never their values.
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.companyId, companyId), eq(auditLogs.action, "company.profile_updated")),
      );
    expect(entry!.metadata).toEqual({
      changed: [
        "name",
        "legalName",
        "registrationNumber",
        "vatNumber",
        "addressLine1",
        "postalCode",
        "city",
      ],
    });
    expect(JSON.stringify(entry!.metadata)).not.toContain("Rīga");
  });

  it("an unchanged submit writes nothing; omitted fields stay as they are; empty clears", async () => {
    const { owner, companyId } = await ownerCompany();
    await updateCompanyProfile(db, verified(owner.id), companyId, PROFILE);
    const audits = () =>
      db.$count(
        auditLogs,
        and(eq(auditLogs.companyId, companyId), eq(auditLogs.action, "company.profile_updated")),
      );
    expect(await audits()).toBe(1);
    await updateCompanyProfile(db, verified(owner.id), companyId, PROFILE);
    expect(await audits()).toBe(1);

    const partial = await updateCompanyProfile(db, verified(owner.id), companyId, {
      name: "Paraugs",
      city: "",
    });
    expect(partial).toMatchObject({
      ok: true,
      profile: { city: null, addressLine1: "Testa iela 1" },
    });
    expect(await audits()).toBe(2);
  });

  it("the country cannot be changed through the profile", async () => {
    const { owner, companyId } = await ownerCompany();
    await updateCompanyProfile(db, verified(owner.id), companyId, { name: "X", country: "PL" });
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row!.country).toBe("LV");
  });

  it("rejects invalid input with field errors and changes nothing", async () => {
    const { owner, companyId } = await ownerCompany("EE");
    const result = await updateCompanyProfile(db, verified(owner.id), companyId, {
      name: "   ",
      vatNumber: "LV40000000000", // wrong country prefix for an Estonian company
      registrationNumber: "<script>",
      postalCode: "x".repeat(17),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(
      ["name", "postalCode", "registrationNumber", "vatNumber"].sort(),
    );
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row).toMatchObject({ name: "Profile Test", vatNumber: null, registrationNumber: null });
  });

  it("VAT numbers are checked for format only, against the company's own country prefix", () => {
    for (const [country, vat, ok] of [
      ["LV", "LV12345678901", true],
      ["LT", "lt 123456789", true],
      ["EE", "EE123456789", true],
      ["PL", "PL-123-456-78-90", true],
      ["PL", "DE123456789", false],
      ["LT", "LT1", false],
      ["EE", "EE1234567890123", false],
    ] as const) {
      expect({
        country,
        vat,
        ok: parseCompanyProfile({ name: "A", vatNumber: vat }, country).success,
      }).toEqual({
        country,
        vat,
        ok,
      });
    }
  });

  it("roles: view-only members can read but not edit; administrators can edit", async () => {
    const { companyId } = await ownerCompany();
    const accountant = await createUser();
    const admin = await createUser();
    await addMember(companyId, accountant.id, "accountant");
    await addMember(companyId, admin.id, "administrator");

    await expect(getCompanyProfile(db, verified(accountant.id), companyId)).resolves.toMatchObject({
      canEdit: false,
    });
    await expect(
      updateCompanyProfile(db, verified(accountant.id), companyId, { name: "Hijacked" }),
    ).rejects.toThrow(ForbiddenError);

    await expect(
      updateCompanyProfile(db, verified(admin.id), companyId, { name: "By admin" }),
    ).resolves.toMatchObject({ ok: true, profile: { name: "By admin" } });
  });

  it("non-members, other tenants, archived companies and owners without 2FA are refused", async () => {
    const { owner, companyId } = await ownerCompany();
    const { owner: otherOwner } = await ownerCompany();
    const stranger = await createUser();

    for (const actor of [verified(stranger.id), verified(otherOwner.id)]) {
      await expect(getCompanyProfile(db, actor, companyId)).rejects.toThrow(ForbiddenError);
      await expect(updateCompanyProfile(db, actor, companyId, { name: "X" })).rejects.toThrow(
        ForbiddenError,
      );
    }
    await expect(
      updateCompanyProfile(db, { userId: owner.id, twoFactorVerified: false }, companyId, {
        name: "X",
      }),
    ).rejects.toThrow(TwoFactorRequiredError);
    await expect(getCompanyProfile(db, verified(owner.id), randomUUID())).rejects.toThrow(
      ForbiddenError,
    );

    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    await expect(getCompanyProfile(db, verified(owner.id), companyId)).rejects.toThrow(
      ForbiddenError,
    );
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row!.name).toBe("Profile Test");
  });
});
