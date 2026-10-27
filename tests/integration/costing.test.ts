import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { products } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Saved cost calculations over the real routes: the server computes and stores the result (a
 * client-supplied result is ignored), products of other companies cannot be linked, versions,
 * CSV export, permissions and isolation. Rates are arbitrary test values.
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

const list = await import("@/app/api/companies/[companyId]/costing/route");
const one = await import("@/app/api/companies/[companyId]/costing/[calculationId]/route");
const csv = await import("@/app/api/companies/[companyId]/costing/[calculationId]/csv/route");

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
const as = (a: Actor | null) => {
  session.actor = a;
};

const calculation = {
  currency: "EUR",
  quantity: "100",
  lines: [
    { category: "purchase", basis: "per_unit", amount: "4.50" },
    { category: "delivery", basis: "total", amount: "120" },
    { category: "customs_duty", basis: "percent", amount: "10", verified: true },
  ],
  salePrice: "9",
};

describe("cost calculations", () => {
  it("stores the server's result, links own products only and keeps versions", async () => {
    const c = await h.newCompany();
    const other = await h.newCompany();
    const [own] = await db
      .insert(products)
      .values({ companyId: c.companyId, name: "Krekls" })
      .returning();
    const [foreign] = await db
      .insert(products)
      .values({ companyId: other.companyId, name: "Svešs" })
      .returning();
    as(c.owner);

    const bad = await call(
      list.POST(
        req("POST", {
          name: "X",
          calculation: {
            ...calculation,
            quantity: "0",
            lines: [{ category: "other", basis: "total", amount: "abc" }],
          },
        }),
        params({ companyId: c.companyId }),
      ),
    );
    expect(bad.status).toBe(422);
    expect(issueCodes(bad.body)).toEqual(["costing.decimal", "costing.positive"]);
    const wrongProduct = await call(
      list.POST(
        req("POST", { name: "X", productId: foreign!.id, calculation }),
        params({ companyId: c.companyId }),
      ),
    );
    expect(issueCodes(wrongProduct.body)).toEqual(["costing.product.unknown"]);

    const created = await call(
      list.POST(
        req("POST", {
          name: "Krekls 100 gab.",
          productId: own!.id,
          calculation: { ...calculation, result: { totalCost: "1" } },
        }),
        params({ companyId: c.companyId }),
      ),
    );
    // An extra "result" in the input is refused (strict), so no client figures can be stored.
    expect(created.status).toBe(422);
    const saved = await call(
      list.POST(
        req("POST", { name: "Krekls 100 gab.", productId: own!.id, calculation }),
        params({ companyId: c.companyId }),
      ),
    );
    expect(saved.status).toBe(201);
    const calc = saved.body.calculation;
    // 450 + 120 + duty 10 % of 570 = 57 → 627.
    expect(calc.result).toMatchObject({ totalCost: "627.00", unitCost: "6.2700" });
    expect(calc.result.pricing).toMatchObject({ marginPercent: "30.33" });
    expect(calc.productName).toBe("Krekls");

    const updated = await call(
      one.PUT(
        req("PUT", {
          name: "Krekls 200",
          calculation: { ...calculation, quantity: "200" },
          expectedVersion: 1,
        }),
        params({ companyId: c.companyId, calculationId: calc.id }),
      ),
    );
    expect(updated.body.calculation).toMatchObject({ version: 2, productId: null });
    expect(updated.body.calculation.result.totalCost).toBe("1122.00");
    expect(
      (
        await call(
          one.PUT(
            req("PUT", { name: "x", calculation, expectedVersion: 1 }),
            params({ companyId: c.companyId, calculationId: calc.id }),
          ),
        )
      ).body,
    ).toEqual({ error: "version_conflict" });

    const file = await csv.GET(
      req("GET"),
      params({ companyId: c.companyId, calculationId: calc.id }),
    );
    const text = new TextDecoder().decode(await file.arrayBuffer());
    expect(text).toContain('total;"Krekls 200";1122.00;5.6100');

    as(other.owner);
    expect(
      (await call(one.GET(req("GET"), params({ companyId: c.companyId, calculationId: calc.id }))))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          one.GET(req("GET"), params({ companyId: other.companyId, calculationId: calc.id })),
        )
      ).status,
    ).toBe(404);
    as(await h.member(c.companyId, "warehouse_employee"));
    expect(
      (await call(list.GET(req("GET"), params({ companyId: c.companyId })))).body.calculations,
    ).toHaveLength(1);
    expect(
      (
        await call(
          list.POST(req("POST", { name: "Y", calculation }), params({ companyId: c.companyId })),
        )
      ).status,
    ).toBe(403);
    as(c.owner);
    expect(
      (
        await call(
          one.DELETE(req("DELETE"), params({ companyId: c.companyId, calculationId: calc.id })),
        )
      ).body,
    ).toEqual({ deleted: true });
    expect(
      (await call(list.GET(req("GET"), params({ companyId: c.companyId })))).body.calculations,
    ).toEqual([]);
  });
});
