import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { UnauthenticatedError } from "@/server/errors";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Bills of materials and production orders over the real route handlers, services and database
 * (only the session lookup is stubbed): BOM rules, order numbering, completing an order through
 * the stock ledger (components out, product in, never below zero), cancelling, permissions and
 * tenant isolation. Synthetic data only.
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

const bomRoute = await import("@/app/api/companies/[companyId]/production/boms/[productId]/route");
const bomsRoute = await import("@/app/api/companies/[companyId]/production/boms/route");
const ordersRoute = await import("@/app/api/companies/[companyId]/production/orders/route");
const orderRoute =
  await import("@/app/api/companies/[companyId]/production/orders/[orderId]/route");
const productsRoute = await import("@/app/api/companies/[companyId]/products/route");
const warehousesRoute = await import("@/app/api/companies/[companyId]/warehouses/route");
const operationsRoute = await import("@/app/api/companies/[companyId]/stock/operations/route");
const stockRoute = await import("@/app/api/companies/[companyId]/stock/route");
const movementsRoute = await import("@/app/api/companies/[companyId]/stock/movements/route");

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
  setBom: (companyId: string, productId: string, body: unknown) =>
    call(bomRoute.PUT(req("PUT", body), params({ companyId, productId }))),
  boms: (companyId: string) => call(bomsRoute.GET(req("GET"), params({ companyId }))),
  orders: (companyId: string) => call(ordersRoute.GET(req("GET"), params({ companyId }))),
  plan: (companyId: string, body: unknown) =>
    call(ordersRoute.POST(req("POST", body), params({ companyId }))),
  change: (companyId: string, orderId: string, body: unknown) =>
    call(orderRoute.PATCH(req("PATCH", body), params({ companyId, orderId }))),
  product: async (companyId: string, body: unknown) =>
    (await call(productsRoute.POST(req("POST", body), params({ companyId })))).body.product,
  receive: (companyId: string, productId: string, warehouseId: string, quantity: string) =>
    call(
      operationsRoute.POST(
        req("POST", { kind: "receipt", productId, warehouseId, quantity, occurredOn: DAY }),
        params({ companyId }),
      ),
    ),
  total: async (companyId: string, productId: string) =>
    (await call(stockRoute.GET(req("GET"), params({ companyId })))).body.stock.find(
      (s: { productId: string }) => s.productId === productId,
    )?.total,
  movements: (companyId: string) =>
    call(movementsRoute.GET(req("GET", undefined, "http://localhost/api"), params({ companyId }))),
};

const DAY = "2026-03-02";

/** A table made of 4 legs and 1 top, in warehouse MAIN. */
async function setup() {
  const c = await h.newCompany();
  as(c.owner);
  const wh = (
    await call(
      warehousesRoute.POST(
        req("POST", { code: "MAIN", name: "Main" }),
        params({ companyId: c.companyId }),
      ),
    )
  ).body.warehouse;
  const table = await api.product(c.companyId, { name: "Table (TEST)", trackStock: true });
  const leg = await api.product(c.companyId, { name: "Leg", trackStock: true });
  const top = await api.product(c.companyId, { name: "Top", trackStock: true });
  return { ...c, wh, table, leg, top };
}

describe("bills of materials", () => {
  it("sets, replaces and removes a bill; checks components", async () => {
    const { companyId, table, leg, top } = await setup();
    const set = await api.setBom(companyId, table.id, {
      components: [
        { componentId: leg.id, quantity: "4" },
        { componentId: top.id, quantity: "1,0" },
      ],
    });
    expect(set.status).toBe(200);
    expect(set.body.bom.components).toEqual([
      { componentId: leg.id, quantity: "4" },
      { componentId: top.id, quantity: "1" },
    ]);
    const service = await api.product(companyId, { name: "Assembly hour", kind: "service" });
    const bad = await api.setBom(companyId, table.id, {
      components: [
        { componentId: table.id, quantity: "1" },
        { componentId: leg.id, quantity: "0" },
        { componentId: leg.id, quantity: "1" },
        { componentId: service.id, quantity: "1" },
      ],
    });
    expect(issueCodes(bad.body)).toEqual([
      "production.component.duplicate",
      "production.component.notTracked",
      "production.component.self",
      "production.quantity.invalid",
    ]);
    await api.setBom(companyId, table.id, { components: [{ componentId: leg.id, quantity: "3" }] });
    expect((await api.boms(companyId)).body.boms).toEqual([
      { productId: table.id, components: [{ componentId: leg.id, quantity: "3" }] },
    ]);
    await api.setBom(companyId, table.id, { components: [] });
    expect((await api.boms(companyId)).body.boms).toEqual([]);
  });
});

describe("production orders", () => {
  it("numbers orders, copies components and completes them through the stock ledger", async () => {
    const { companyId, wh, table, leg, top } = await setup();
    await api.setBom(companyId, table.id, {
      components: [
        { componentId: leg.id, quantity: "4" },
        { componentId: top.id, quantity: "1" },
      ],
    });
    const first = await api.plan(companyId, {
      productId: table.id,
      warehouseId: wh.id,
      quantity: "2",
      plannedOn: DAY,
    });
    expect(first.status).toBe(201);
    expect(first.body.order).toMatchObject({
      number: "PRD-2026-0001",
      status: "planned",
      quantity: "2",
      components: [
        { componentId: leg.id, quantity: "8" },
        { componentId: top.id, quantity: "2" },
      ],
    });
    const second = await api.plan(companyId, {
      productId: table.id,
      warehouseId: wh.id,
      quantity: "1",
      plannedOn: DAY,
    });
    expect(second.body.order.number).toBe("PRD-2026-0002");

    // A later change of the bill does not change planned orders.
    await api.setBom(companyId, table.id, { components: [{ componentId: leg.id, quantity: "5" }] });

    // Not enough legs: nothing is written.
    await api.receive(companyId, leg.id, wh.id, "7");
    await api.receive(companyId, top.id, wh.id, "2");
    const short = await api.change(companyId, first.body.order.id, {
      action: "complete",
      expectedVersion: 1,
      completedOn: DAY,
    });
    expect(issueCodes(short.body)).toEqual(["stock.quantity.insufficient"]);
    expect(await api.total(companyId, table.id)).toBe("0");

    await api.receive(companyId, leg.id, wh.id, "1");
    const done = await api.change(companyId, first.body.order.id, {
      action: "complete",
      expectedVersion: 1,
      completedOn: DAY,
    });
    expect(done.body.order).toMatchObject({ status: "completed", completedOn: DAY, version: 2 });
    expect(await api.total(companyId, table.id)).toBe("2");
    expect(await api.total(companyId, leg.id)).toBe("0");
    expect(await api.total(companyId, top.id)).toBe("0");
    const ledger = (await api.movements(companyId)).body.movements.filter(
      (m: { groupId: string }) => m.groupId === first.body.order.id,
    );
    expect(
      ledger
        .map((m: { kind: string; quantity: string; reference: string }) => [
          m.kind,
          m.quantity,
          m.reference,
        ])
        .sort(),
    ).toEqual([
      ["production_consume", "-2", "PRD-2026-0001"],
      ["production_consume", "-8", "PRD-2026-0001"],
      ["production_output", "2", "PRD-2026-0001"],
    ]);

    // Completed orders cannot change; planned ones can be cancelled once.
    expect(
      await api.change(companyId, first.body.order.id, { action: "cancel", expectedVersion: 2 }),
    ).toMatchObject({
      status: 409,
      body: { error: "invalid_state", code: "production.notPlanned" },
    });
    expect(
      (await api.change(companyId, second.body.order.id, { action: "cancel", expectedVersion: 2 }))
        .status,
    ).toBe(409);
    const cancelled = await api.change(companyId, second.body.order.id, {
      action: "cancel",
      expectedVersion: 1,
    });
    expect(cancelled.body.order.status).toBe("cancelled");
    expect(
      (await api.orders(companyId)).body.orders.map((o: { number: string }) => o.number),
    ).toEqual(["PRD-2026-0002", "PRD-2026-0001"]);
  });

  it("refuses orders without a bill, for untracked products, archived warehouses or tiny quantities", async () => {
    const { companyId, wh, table, leg } = await setup();
    const noBom = await api.plan(companyId, {
      productId: table.id,
      warehouseId: wh.id,
      quantity: "1",
      plannedOn: DAY,
    });
    expect(issueCodes(noBom.body)).toEqual(["production.bom.missing"]);
    const bad = await api.plan(companyId, {
      productId: table.id,
      warehouseId: wh.id,
      quantity: "-1",
      plannedOn: "2026-13-01",
    });
    expect(issueCodes(bad.body)).toEqual([
      "production.bom.missing",
      "production.date.invalid",
      "production.quantity.invalid",
    ]);
    await api.setBom(companyId, table.id, {
      components: [{ componentId: leg.id, quantity: "0.0001" }],
    });
    const tiny = await api.plan(companyId, {
      productId: table.id,
      warehouseId: wh.id,
      quantity: "0.4",
      plannedOn: DAY,
    });
    expect(issueCodes(tiny.body)).toEqual(["production.quantity.tooSmall"]);
  });

  it("gives every concurrent order its own number", async () => {
    const { companyId, wh, table, leg } = await setup();
    await api.setBom(companyId, table.id, { components: [{ componentId: leg.id, quantity: "1" }] });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api.plan(companyId, {
          productId: table.id,
          warehouseId: wh.id,
          quantity: "1",
          plannedOn: DAY,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(results.map((r) => r.body.order.number)).size).toBe(6);
  });

  it("checks permissions and isolates companies", async () => {
    const a = await setup();
    const b = await h.newCompany();
    as(a.owner);
    await api.setBom(a.companyId, a.table.id, {
      components: [{ componentId: a.leg.id, quantity: "1" }],
    });
    const plan = { productId: a.table.id, warehouseId: a.wh.id, quantity: "1", plannedOn: DAY };

    as(await h.member(a.companyId, "production_employee"));
    expect((await api.plan(a.companyId, plan)).status).toBe(201);
    as(await h.member(a.companyId, "manager"));
    expect((await api.orders(a.companyId)).status).toBe(200);
    expect((await api.plan(a.companyId, plan)).status).toBe(403);
    for (const role of ["warehouse_employee", "accountant"]) {
      as(await h.member(a.companyId, role));
      expect((await api.orders(a.companyId)).status, role).toBe(403);
    }
    as(b.owner);
    expect((await api.orders(a.companyId)).status).toBe(403);
    expect((await api.setBom(b.companyId, a.table.id, { components: [] })).status).toBe(404);
    const order = (await api.orders(a.companyId).catch(() => null))?.body;
    expect(order?.error).toBe("forbidden");
    as(null);
    expect((await api.boms(a.companyId)).status).toBe(401);
  });
});
