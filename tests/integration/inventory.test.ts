import { eq, sql } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { stockMovements } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Warehouses and the stock ledger over the real route handlers, services and database (only the
 * session lookup is stubbed): receipts, issues, transfers and counts, the zero floor under
 * concurrent requests, the append-only ledger, permissions and tenant isolation. Synthetic data.
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

const warehousesRoute = await import("@/app/api/companies/[companyId]/warehouses/route");
const warehouseRoute =
  await import("@/app/api/companies/[companyId]/warehouses/[warehouseId]/route");
const stockRoute = await import("@/app/api/companies/[companyId]/stock/route");
const movementsRoute = await import("@/app/api/companies/[companyId]/stock/movements/route");
const operationsRoute = await import("@/app/api/companies/[companyId]/stock/operations/route");
const productsRoute = await import("@/app/api/companies/[companyId]/products/route");
const productRoute = await import("@/app/api/companies/[companyId]/products/[productId]/route");

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
  warehouses: (companyId: string) =>
    call(
      warehousesRoute.GET(
        req("GET", undefined, "http://localhost/api?includeArchived=1"),
        params({ companyId }),
      ),
    ),
  addWarehouse: (companyId: string, body: unknown) =>
    call(warehousesRoute.POST(req("POST", body), params({ companyId }))),
  patchWarehouse: (companyId: string, warehouseId: string, body: unknown) =>
    call(warehouseRoute.PATCH(req("PATCH", body), params({ companyId, warehouseId }))),
  stock: (companyId: string) => call(stockRoute.GET(req("GET"), params({ companyId }))),
  movements: (companyId: string, query = "") =>
    call(
      movementsRoute.GET(
        req("GET", undefined, `http://localhost/api?${query}`),
        params({ companyId }),
      ),
    ),
  op: (companyId: string, body: unknown) =>
    call(operationsRoute.POST(req("POST", body), params({ companyId }))),
  addProduct: (companyId: string, body: unknown) =>
    call(productsRoute.POST(req("POST", body), params({ companyId }))),
  patchProduct: (companyId: string, productId: string, body: unknown) =>
    call(productRoute.PATCH(req("PATCH", body), params({ companyId, productId }))),
};

const DAY = "2026-03-02";

/** Owner, two warehouses (MAIN default, RIGA) and a tracked product. */
async function setup() {
  const c = await h.newCompany();
  as(c.owner);
  const main = (await api.addWarehouse(c.companyId, { code: " main ", name: "Main warehouse" }))
    .body.warehouse;
  const riga = (await api.addWarehouse(c.companyId, { code: "RIGA", name: "Rīga" })).body.warehouse;
  const product = (
    await api.addProduct(c.companyId, {
      name: "Safety boots (TEST)",
      unit: "pair",
      trackStock: true,
      purchasePrice: "30",
    })
  ).body.product;
  return { ...c, main, riga, product };
}

const level = async (companyId: string, productId: string) =>
  (await api.stock(companyId)).body.stock.find(
    (s: { productId: string }) => s.productId === productId,
  );

describe("warehouses", () => {
  it("makes the first warehouse the default, normalizes codes and refuses a used code", async () => {
    const { companyId, main, riga } = await setup();
    expect(main).toMatchObject({ code: "MAIN", isDefault: true, version: 1 });
    expect(riga).toMatchObject({ code: "RIGA", isDefault: false });
    expect(await api.addWarehouse(companyId, { code: "main", name: "Again" })).toMatchObject({
      status: 409,
      body: { error: "code_taken" },
    });
    const bad = await api.addWarehouse(companyId, { code: "a b", name: " " });
    expect(issueCodes(bad.body)).toEqual(["warehouse.code.invalid", "warehouse.name.required"]);
    // Making RIGA the default clears MAIN.
    await api.patchWarehouse(companyId, riga.id, { expectedVersion: 1, isDefault: true });
    const list = (await api.warehouses(companyId)).body.warehouses;
    expect(list.map((w: { code: string; isDefault: boolean }) => [w.code, w.isDefault])).toEqual([
      ["RIGA", true],
      ["MAIN", false],
    ]);
  });

  it("archives only an empty warehouse; an archived one takes no stock", async () => {
    const { companyId, main, riga, product } = await setup();
    await api.op(companyId, {
      kind: "receipt",
      productId: product.id,
      warehouseId: riga.id,
      quantity: "2",
      occurredOn: DAY,
    });
    expect(
      await api.patchWarehouse(companyId, riga.id, { expectedVersion: 1, archived: true }),
    ).toMatchObject({
      status: 409,
      body: { error: "invalid_state", code: "warehouse.notEmpty" },
    });
    await api.op(companyId, {
      kind: "transfer",
      productId: product.id,
      warehouseId: riga.id,
      toWarehouseId: main.id,
      quantity: "2",
      occurredOn: DAY,
    });
    const archived = await api.patchWarehouse(companyId, riga.id, {
      expectedVersion: 1,
      archived: true,
    });
    expect(archived.body.warehouse).toMatchObject({ archived: true, isDefault: false, version: 2 });
    const refused = await api.op(companyId, {
      kind: "receipt",
      productId: product.id,
      warehouseId: riga.id,
      quantity: "1",
      occurredOn: DAY,
    });
    expect(issueCodes(refused.body)).toEqual(["stock.warehouse.archived"]);
  });
});

describe("stock operations", () => {
  it("receives, issues, transfers and counts with exact decimal balances", async () => {
    const { companyId, main, riga, product } = await setup();
    const receipt = await api.op(companyId, {
      kind: "receipt",
      productId: product.id,
      warehouseId: main.id,
      quantity: "10,5",
      unitCost: "29.9",
      occurredOn: DAY,
      reference: "PO-1",
    });
    expect(receipt.status).toBe(201);
    expect(receipt.body.movements).toMatchObject([
      { kind: "receipt", quantity: "10.5", unitCost: "29.9", reference: "PO-1" },
    ]);
    await api.op(companyId, {
      kind: "issue",
      productId: product.id,
      warehouseId: main.id,
      quantity: "0.0001",
      occurredOn: DAY,
    });
    const transfer = await api.op(companyId, {
      kind: "transfer",
      productId: product.id,
      warehouseId: main.id,
      toWarehouseId: riga.id,
      quantity: "3",
      occurredOn: DAY,
    });
    expect(
      transfer.body.movements.map((m: { kind: string; quantity: string }) => [m.kind, m.quantity]),
    ).toEqual([
      ["transfer_out", "-3"],
      ["transfer_in", "3"],
    ]);
    // Both halves of a transfer share a group.
    expect(transfer.body.movements[0].groupId).toBe(transfer.body.movements[1].groupId);
    expect(await level(companyId, product.id)).toMatchObject({
      total: "10.4999",
      byWarehouse: { [main.id]: "7.4999", [riga.id]: "3" },
      purchasePrice: "30",
    });
    // A count writes the difference; a matching count writes nothing.
    const count = await api.op(companyId, {
      kind: "count",
      productId: product.id,
      warehouseId: riga.id,
      quantity: "2",
      occurredOn: DAY,
    });
    expect(count.body.movements).toMatchObject([{ kind: "adjustment", quantity: "-1" }]);
    expect(
      (
        await api.op(companyId, {
          kind: "count",
          productId: product.id,
          warehouseId: riga.id,
          quantity: "2",
          occurredOn: DAY,
        })
      ).body.movements,
    ).toEqual([]);
    const history = (await api.movements(companyId, `productId=${product.id}`)).body.movements;
    // Newest first; the two halves of a transfer are written in one transaction (same time).
    expect(history.map((m: { kind: string }) => m.kind)).toHaveLength(5);
    expect(history[0].kind).toBe("adjustment");
    expect(history.at(-1).kind).toBe("receipt");
  });

  it("never lets a balance go below zero and reports invalid input together", async () => {
    const { companyId, main, riga, product } = await setup();
    await api.op(companyId, {
      kind: "receipt",
      productId: product.id,
      warehouseId: main.id,
      quantity: "1",
      occurredOn: DAY,
    });
    const tooMuch = await api.op(companyId, {
      kind: "issue",
      productId: product.id,
      warehouseId: main.id,
      quantity: "1.0001",
      occurredOn: DAY,
    });
    expect(issueCodes(tooMuch.body)).toEqual(["stock.quantity.insufficient"]);
    const fromEmpty = await api.op(companyId, {
      kind: "transfer",
      productId: product.id,
      warehouseId: riga.id,
      toWarehouseId: main.id,
      quantity: "1",
      occurredOn: DAY,
    });
    expect(issueCodes(fromEmpty.body)).toEqual(["stock.quantity.insufficient"]);
    const bad = await api.op(companyId, {
      kind: "transfer",
      productId: product.id,
      warehouseId: main.id,
      toWarehouseId: main.id,
      quantity: "0",
      unitCost: "1",
      occurredOn: "2026-02-30",
    });
    expect(issueCodes(bad.body)).toEqual([
      "stock.date.invalid",
      "stock.quantity.invalid",
      "stock.transfer.sameWarehouse",
      "stock.unitCost.invalid",
    ]);
    const future = await api.op(companyId, {
      kind: "receipt",
      productId: product.id,
      warehouseId: main.id,
      quantity: "1",
      occurredOn: "2099-01-01",
    });
    expect(issueCodes(future.body)).toEqual(["stock.date.future"]);
    // Services and goods without stock tracking have no stock.
    const service = (await api.addProduct(companyId, { name: "Hour", kind: "service" })).body
      .product;
    const notTracked = await api.op(companyId, {
      kind: "receipt",
      productId: service.id,
      warehouseId: main.id,
      quantity: "1",
      occurredOn: DAY,
    });
    expect(issueCodes(notTracked.body)).toEqual(["stock.product.notTracked"]);
    expect((await level(companyId, product.id)).total).toBe("1");
  });

  it("serializes concurrent issues: exactly the available quantity goes out", async () => {
    const { companyId, main, product } = await setup();
    await api.op(companyId, {
      kind: "receipt",
      productId: product.id,
      warehouseId: main.id,
      quantity: "5",
      occurredOn: DAY,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        api.op(companyId, {
          kind: "issue",
          productId: product.id,
          warehouseId: main.id,
          quantity: "1",
          occurredOn: DAY,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 422)).toHaveLength(7);
    expect((await level(companyId, product.id)).total).toBe("0");
  });

  it("keeps the ledger append-only and stock tracking on once a product has movements", async () => {
    const { companyId, main, product } = await setup();
    await api.op(companyId, {
      kind: "receipt",
      productId: product.id,
      warehouseId: main.id,
      quantity: "1",
      occurredOn: DAY,
    });
    // Drizzle wraps the database error; the trigger's message is its cause.
    const cause = (p: Promise<unknown>) =>
      p.then(
        () => "no error",
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(
      await cause(
        db.execute(sql`update stock_movements set quantity = 100 where company_id = ${companyId}`),
      ),
    ).toMatch(/append-only/);
    expect(
      await cause(db.delete(stockMovements).where(eq(stockMovements.companyId, companyId))),
    ).toMatch(/append-only/);
    const off = await api.patchProduct(companyId, product.id, {
      expectedVersion: 1,
      trackStock: false,
    });
    expect(issueCodes(off.body)).toEqual(["product.trackStock.inUse"]);
  });

  it("checks permissions and isolates companies", async () => {
    const a = await setup();
    const b = await h.newCompany();
    const receipt = {
      kind: "receipt",
      productId: a.product.id,
      warehouseId: a.main.id,
      quantity: "1",
      occurredOn: DAY,
    };

    as(await h.member(a.companyId, "warehouse_employee"));
    expect((await api.op(a.companyId, receipt)).status).toBe(201);
    expect((await api.addWarehouse(a.companyId, { code: "W2", name: "W2" })).status).toBe(201);
    for (const role of ["manager", "accountant", "production_employee"]) {
      as(await h.member(a.companyId, role));
      expect((await api.stock(a.companyId)).status, role).toBe(200);
      expect((await api.op(a.companyId, receipt)).status, role).toBe(403);
    }
    as(b.owner);
    expect((await api.stock(a.companyId)).status).toBe(403);
    // Another company's product or warehouse ids are unknown here.
    const w = (await api.addWarehouse(b.companyId, { code: "B", name: "B" })).body.warehouse;
    const cross = await api.op(b.companyId, { ...receipt, warehouseId: w.id });
    expect(issueCodes(cross.body)).toEqual(["stock.product.unknown"]);
    expect(
      (await api.patchWarehouse(b.companyId, a.main.id, { expectedVersion: 1, name: "X" })).status,
    ).toBe(404);
    as(null);
    expect((await api.movements(a.companyId)).status).toBe(401);
  });
});
