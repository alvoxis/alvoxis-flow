import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Customers and suppliers over the real route handlers, services and database (only the session
 * lookup is stubbed): validation, uniqueness of registration numbers, roles and permissions per
 * kind, tenant isolation, optimistic versions and the audit trail. Synthetic data only.
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

const collection = await import("@/app/api/companies/[companyId]/counterparties/route");
const single =
  await import("@/app/api/companies/[companyId]/counterparties/[counterpartyId]/route");

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
const as = (actor: Actor | null) => {
  session.actor = actor;
};

const api = {
  list: (companyId: string, query: string) =>
    call(
      collection.GET(req("GET", undefined, `http://localhost/api?${query}`), params({ companyId })),
    ),
  create: (companyId: string, body: unknown) =>
    call(collection.POST(req("POST", body), params({ companyId }))),
  get: (companyId: string, counterpartyId: string) =>
    call(single.GET(req("GET"), params({ companyId, counterpartyId }))),
  patch: (companyId: string, counterpartyId: string, body: unknown) =>
    call(single.PATCH(req("PATCH", body), params({ companyId, counterpartyId }))),
};

const CUSTOMER = {
  name: "  Baltic Test Buyer SIA ",
  isCustomer: true,
  registrationNumber: "40000000099",
  vatNumber: "lv 4000 0000 099",
  email: "buyer@example.test",
  countryCode: "lv",
  city: "Rīga",
  paymentTermDays: 14,
};

describe("counterparties API", () => {
  it("adds a customer with normalized fields and lists it by kind and search", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const created = await api.create(companyId, CUSTOMER);
    expect(created.status).toBe(201);
    expect(created.body.counterparty).toMatchObject({
      name: "Baltic Test Buyer SIA",
      isCustomer: true,
      isSupplier: false,
      vatNumber: "LV40000000099",
      countryCode: "LV",
      paymentTermDays: 14,
      phone: null,
      archived: false,
      version: 1,
    });
    await api.create(companyId, { name: "Nemunas Supplies UAB", isSupplier: true });

    const customers = await api.list(companyId, "kind=customer");
    expect(customers.status).toBe(200);
    expect(customers.body.counterparties.map((c: { name: string }) => c.name)).toEqual([
      "Baltic Test Buyer SIA",
    ]);
    const suppliers = await api.list(companyId, "kind=supplier");
    expect(suppliers.body.counterparties.map((c: { name: string }) => c.name)).toEqual([
      "Nemunas Supplies UAB",
    ]);
    // Search covers name, registration and VAT numbers, email and contact; % and _ are literal.
    for (const q of ["baltic", "40000000099", "LV4000", "buyer@"])
      expect((await api.list(companyId, `kind=customer&q=${q}`)).body.counterparties).toHaveLength(
        1,
      );
    for (const q of ["nemunas", "%", "_"])
      expect(
        (await api.list(companyId, `kind=customer&q=${encodeURIComponent(q)}`)).body.counterparties,
      ).toHaveLength(0);
    expect((await api.list(companyId, "kind=other")).status).toBe(400);
  });

  it("reports every invalid field at once", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const res = await api.create(companyId, {
      name: "   ",
      email: "not-an-email",
      countryCode: "L1",
      vatNumber: "12",
      paymentTermDays: 400,
    });
    expect(res).toMatchObject({ status: 422, body: { error: "validation_failed" } });
    expect(issueCodes(res.body)).toEqual([
      "counterparty.countryCode.invalid",
      "counterparty.email.invalid",
      "counterparty.name.required",
      "counterparty.paymentTermDays.range",
      "counterparty.role.required",
      "counterparty.vatNumber.invalid",
    ]);
    // Unknown fields and wrong types are shape errors on the field.
    const shape = await api.create(companyId, { name: "X", isCustomer: true, iban: "LV00" });
    expect(shape.status).toBe(422);
  });

  it("keeps registration numbers unique among active records; archiving frees the number", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const first = (await api.create(companyId, CUSTOMER)).body.counterparty;
    const dup = await api.create(companyId, { ...CUSTOMER, name: "Another" });
    expect(dup).toMatchObject({ status: 409, body: { error: "registration_taken" } });

    const archived = await api.patch(companyId, first.id, { expectedVersion: 1, archived: true });
    expect(archived.body.counterparty).toMatchObject({ archived: true, version: 2 });
    const second = await api.create(companyId, { ...CUSTOMER, name: "Another" });
    expect(second.status).toBe(201);
    // Restoring the first would make the number appear twice.
    const restore = await api.patch(companyId, first.id, { expectedVersion: 2, archived: false });
    expect(restore).toMatchObject({ status: 409, body: { error: "registration_taken" } });
    // Archived records are listed only on request.
    expect((await api.list(companyId, "kind=customer")).body.counterparties).toHaveLength(1);
    expect(
      (await api.list(companyId, "kind=customer&includeArchived=1")).body.counterparties,
    ).toHaveLength(2);
  });

  it("edits with optimistic versions; a record can become both customer and supplier", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const c = (await api.create(companyId, CUSTOMER)).body.counterparty;
    const edited = await api.patch(companyId, c.id, {
      expectedVersion: 1,
      isSupplier: true,
      phone: "+371 20000000",
      email: "",
    });
    expect(edited.body.counterparty).toMatchObject({
      isCustomer: true,
      isSupplier: true,
      phone: "+371 20000000",
      email: null,
      version: 2,
    });
    expect((await api.list(companyId, "kind=supplier")).body.counterparties).toHaveLength(1);
    const stale = await api.patch(companyId, c.id, { expectedVersion: 1, name: "Old" });
    expect(stale).toMatchObject({ status: 409, body: { error: "version_conflict" } });
    // No change → same version.
    const same = await api.patch(companyId, c.id, {
      expectedVersion: 2,
      name: "Baltic Test Buyer SIA",
    });
    expect(same.body.counterparty.version).toBe(2);
    // Removing both roles is not allowed.
    const none = await api.patch(companyId, c.id, {
      expectedVersion: 2,
      isCustomer: false,
      isSupplier: false,
    });
    expect(issueCodes(none.body)).toEqual(["counterparty.role.required"]);

    const audit = await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityId, c.id)));
    expect(audit.map((a) => a.action).sort()).toEqual([
      "counterparty.created",
      "counterparty.updated",
    ]);
    // Field names only, never the values (names, emails, phones).
    expect(JSON.stringify(audit)).not.toMatch(/Baltic|example\.test|\+371/);
  });

  it("checks the permission of each role: view, manage, and both for a record that is both", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const both = (
      await api.create(companyId, { name: "Dual SIA", isCustomer: true, isSupplier: true })
    ).body.counterparty;

    // Warehouse employees have no access to customers or suppliers.
    as(await h.member(companyId, "warehouse_employee"));
    expect((await api.list(companyId, "kind=customer")).status).toBe(403);
    expect((await api.get(companyId, both.id)).status).toBe(404);

    // Managers manage both kinds.
    as(await h.member(companyId, "manager"));
    expect((await api.create(companyId, { name: "M Co", isCustomer: true })).status).toBe(201);

    // A role that may manage customers but only view suppliers.
    as(await h.customMember(companyId, ["customers.view", "customers.manage", "suppliers.view"]));
    expect((await api.create(companyId, { name: "C only", isCustomer: true })).status).toBe(201);
    expect((await api.create(companyId, { name: "S", isSupplier: true })).status).toBe(403);
    expect((await api.patch(companyId, both.id, { expectedVersion: 1, phone: "1" })).status).toBe(
      403,
    );

    // A role that only views customers: read-only, suppliers hidden.
    as(await h.customMember(companyId, ["customers.view"]));
    expect((await api.list(companyId, "kind=customer")).status).toBe(200);
    expect((await api.list(companyId, "kind=supplier")).status).toBe(403);
    expect((await api.get(companyId, both.id)).status).toBe(200);
    expect((await api.create(companyId, { name: "X", isCustomer: true })).status).toBe(403);
  });

  it("isolates companies and requires a session", async () => {
    const a = await h.newCompany("A Co");
    const b = await h.newCompany("B Co");
    as(a.owner);
    const rec = (await api.create(a.companyId, CUSTOMER)).body.counterparty;

    as(b.owner);
    expect((await api.list(a.companyId, "kind=customer")).status).toBe(403);
    expect((await api.get(b.companyId, rec.id)).status).toBe(404);
    expect(
      (await api.patch(b.companyId, rec.id, { expectedVersion: 1, name: "Hijack" })).status,
    ).toBe(404);
    // The same registration number may exist in another company.
    expect((await api.create(b.companyId, CUSTOMER)).status).toBe(201);

    as(null);
    expect((await api.list(a.companyId, "kind=customer")).status).toBe(401);
    expect((await api.create(a.companyId, CUSTOMER)).status).toBe(401);
  });
});
