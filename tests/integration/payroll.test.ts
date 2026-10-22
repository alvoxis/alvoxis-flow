import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { UnauthenticatedError } from "@/server/errors";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Payroll over the real route handlers, services and database (only the session lookup is
 * stubbed): rates per country, employees, monthly runs (employment period, gross changes,
 * recalculation, approval as final), the CSV export, and that salaries stay invisible without
 * payroll.view. Synthetic people and amounts only.
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

const ratesRoute = await import("@/app/api/companies/[companyId]/payroll/rates/route");
const employeesRoute = await import("@/app/api/companies/[companyId]/payroll/employees/route");
const employeeRoute =
  await import("@/app/api/companies/[companyId]/payroll/employees/[employeeId]/route");
const runsRoute = await import("@/app/api/companies/[companyId]/payroll/runs/route");
const runRoute = await import("@/app/api/companies/[companyId]/payroll/runs/[runId]/route");
const csvRoute = await import("@/app/api/companies/[companyId]/payroll/runs/[runId]/csv/route");

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
  rates: (companyId: string) => call(ratesRoute.GET(req("GET"), params({ companyId }))),
  setRates: (companyId: string, body: unknown) =>
    call(ratesRoute.PUT(req("PUT", body), params({ companyId }))),
  employees: (companyId: string) =>
    call(
      employeesRoute.GET(
        req("GET", undefined, "http://localhost/api?includeArchived=1"),
        params({ companyId }),
      ),
    ),
  hire: (companyId: string, body: unknown) =>
    call(employeesRoute.POST(req("POST", body), params({ companyId }))),
  editEmployee: (companyId: string, employeeId: string, body: unknown) =>
    call(employeeRoute.PATCH(req("PATCH", body), params({ companyId, employeeId }))),
  runs: (companyId: string) => call(runsRoute.GET(req("GET"), params({ companyId }))),
  start: (companyId: string, period: string) =>
    call(runsRoute.POST(req("POST", { period }), params({ companyId }))),
  change: (companyId: string, runId: string, body: unknown) =>
    call(runRoute.PATCH(req("PATCH", body), params({ companyId, runId }))),
  remove: (companyId: string, runId: string, version: number) =>
    call(
      runRoute.DELETE(
        req("DELETE", undefined, `http://localhost/api?expectedVersion=${version}`),
        params({ companyId, runId }),
      ),
    ),
  csv: async (companyId: string, runId: string) => {
    const r = await csvRoute.GET(req("GET"), params({ companyId, runId }));
    const bytes = new Uint8Array(await r.arrayBuffer());
    return {
      status: r.status,
      type: r.headers.get("content-type"),
      // Excel needs the UTF-8 byte order mark to read Latvian/Polish letters correctly.
      bom: [...bytes.slice(0, 3)].join(","),
      text: new TextDecoder().decode(bytes),
    };
  },
};

const ANNA = {
  firstName: "Anna",
  lastName: "Testa",
  taxCountry: "lv",
  employmentStart: "2026-01-15",
  monthlyGross: "2000",
  monthlyAllowance: "510",
};

describe("payroll", () => {
  it("serves default rates until the company saves its own, with versions", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const rates = (await api.rates(companyId)).body.rates;
    expect(
      rates.map((r: { country: string; isDefault: boolean }) => [r.country, r.isDefault]),
    ).toEqual([
      ["LV", true],
      ["LT", true],
      ["EE", true],
      ["PL", true],
    ]);
    const lv = {
      country: "LV",
      employeeSocialRate: "10.5",
      employerSocialRate: "23.59",
      incomeTaxRate: "25,5",
      employeeHealthRate: "0",
    };
    const saved = await api.setRates(companyId, { ...lv, expectedVersion: 0, incomeTaxRate: "26" });
    expect(saved.body.rates).toMatchObject({
      country: "LV",
      incomeTaxRate: "26",
      isDefault: false,
      version: 1,
    });
    expect((await api.setRates(companyId, { ...lv, expectedVersion: 0 })).status).toBe(409);
    const bad = await api.setRates(companyId, {
      ...lv,
      expectedVersion: 1,
      employeeSocialRate: "100",
      incomeTaxRate: "-1",
    });
    expect(issueCodes(bad.body)).toEqual(["payroll.rate.invalid", "payroll.rate.invalid"]);
  });

  it("validates employees and calculates a month from salary, allowance and rates", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const bad = await api.hire(companyId, {
      firstName: " ",
      lastName: "",
      taxCountry: "DE",
      employmentStart: "2026-02-30",
      employmentEnd: "2025-01-01",
      monthlyGross: "-5",
      email: "x",
    });
    expect(issueCodes(bad.body)).toEqual([
      "payroll.amount.invalid",
      "payroll.country.invalid",
      "payroll.date.invalid",
      "payroll.email.invalid",
      "payroll.firstName.required",
      "payroll.lastName.required",
    ]);
    const anna = (await api.hire(companyId, ANNA)).body.employee;
    expect(anna).toMatchObject({
      taxCountry: "LV",
      currency: "EUR",
      monthlyGross: "2000.00",
      monthlyAllowance: "510.00",
    });
    // Employed only from March: not in the February run.
    await api.hire(companyId, { ...ANNA, firstName: "Jānis", employmentStart: "2026-03-01" });
    // Left in January: not in February either.
    await api.hire(companyId, {
      ...ANNA,
      firstName: "Ilze",
      employmentStart: "2025-01-01",
      employmentEnd: "2026-01-31",
    });
    await api.hire(companyId, {
      firstName: "Piotr",
      lastName: "Testowy",
      taxCountry: "PL",
      employmentStart: "2026-01-01",
      monthlyGross: "8000",
      monthlyAllowance: "250",
      monthlyTaxCredit: "300",
    });

    const run = await api.start(companyId, "2026-02");
    expect(run.status).toBe(201);
    expect(run.body.run.lines.map((l: { employeeName: string }) => l.employeeName)).toEqual([
      "Anna Testa",
      "Piotr Testowy",
    ]);
    expect(run.body.run.lines[0]).toMatchObject({
      currency: "EUR",
      gross: "2000.00",
      employeeSocial: "210.00",
      taxable: "1280.00",
      incomeTax: "326.40",
      net: "1463.60",
      employerCost: "2471.80",
    });
    expect(run.body.run.lines[1]).toMatchObject({
      currency: "PLN",
      health: "621.29",
      incomeTax: "498.38",
      net: "5783.53",
    });
    expect(await api.start(companyId, "2026-02")).toMatchObject({
      status: 409,
      body: { error: "period_taken" },
    });
    expect(issueCodes((await api.start(companyId, "2026-13")).body)).toEqual([
      "payroll.period.invalid",
    ]);
    expect(issueCodes((await api.start(companyId, "2020-01")).body)).toEqual([
      "payroll.run.noEmployees",
    ]);
  });

  it("changes a gross amount, keeps it on recalculation, uses new rates, and freezes on approval", async () => {
    const { owner, companyId } = await h.newCompany();
    as(owner);
    const anna = (await api.hire(companyId, ANNA)).body.employee;
    const run = (await api.start(companyId, "2026-02")).body.run;
    const bonus = await api.change(companyId, run.id, {
      action: "setGross",
      expectedVersion: 1,
      employeeId: anna.id,
      gross: "2500",
    });
    expect(bonus.body.run.lines[0]).toMatchObject({ gross: "2500.00", incomeTax: "440.51" });
    await api.setRates(companyId, {
      country: "LV",
      expectedVersion: 0,
      employeeSocialRate: "10",
      employerSocialRate: "20",
      incomeTaxRate: "20",
      employeeHealthRate: "0",
    });
    const recalc = await api.change(companyId, run.id, {
      action: "recalculate",
      expectedVersion: 2,
    });
    expect(recalc.body.run.lines[0]).toMatchObject({
      gross: "2500.00",
      employeeSocial: "250.00",
      incomeTax: "348.00",
    });
    expect(recalc.body.run.lines[0].rates).toMatchObject({ incomeTaxRate: "20" });
    // A later salary change does not alter the run.
    await api.editEmployee(companyId, anna.id, { expectedVersion: 1, monthlyGross: "9999" });

    const approved = await api.change(companyId, run.id, { action: "approve", expectedVersion: 3 });
    expect(approved.body.run).toMatchObject({ status: "approved", version: 4 });
    expect(approved.body.run.lines[0].gross).toBe("2500.00");
    expect(
      await api.change(companyId, run.id, { action: "recalculate", expectedVersion: 4 }),
    ).toMatchObject({
      status: 409,
      body: { error: "invalid_state", code: "payroll.approved" },
    });
    expect((await api.remove(companyId, run.id, 4)).status).toBe(409);

    // CSV: semicolons, BOM, quoted names, no formula injection.
    await api.editEmployee(companyId, anna.id, { expectedVersion: 2, firstName: "=HYPERLINK(1)" });
    const draft = (await api.start(companyId, "2026-03")).body.run;
    const csv = await api.csv(companyId, draft.id);
    expect(csv.type).toBe("text/csv; charset=utf-8");
    expect(csv.bom).toBe("239,187,191");
    expect(csv.text.startsWith("employee;country;currency;gross")).toBe(true);
    expect(csv.text).toContain(`"'=HYPERLINK(1) Testa";LV;EUR;9999.00`);
    expect((await api.remove(companyId, draft.id, 1)).body).toEqual({ deleted: true });
    expect((await api.runs(companyId)).body.runs.map((r: { period: string }) => r.period)).toEqual([
      "2026-02",
    ]);
  });

  it("keeps salaries away from roles without payroll access and isolates companies", async () => {
    const a = await h.newCompany();
    const b = await h.newCompany();
    as(a.owner);
    const anna = (await api.hire(a.companyId, ANNA)).body.employee;
    const run = (await api.start(a.companyId, "2026-02")).body.run;

    as(await h.member(a.companyId, "accountant"));
    expect((await api.runs(a.companyId)).status).toBe(200);
    expect((await api.hire(a.companyId, { ...ANNA, firstName: "Acc" })).status).toBe(201);
    for (const role of ["manager", "warehouse_employee", "production_employee"]) {
      as(await h.member(a.companyId, role));
      expect((await api.employees(a.companyId)).status, role).toBe(403);
      expect((await api.runs(a.companyId)).status, role).toBe(403);
      expect((await api.csv(a.companyId, run.id)).status, role).toBe(403);
    }
    as(b.owner);
    expect((await api.employees(a.companyId)).status).toBe(403);
    expect(
      (await api.editEmployee(b.companyId, anna.id, { expectedVersion: 1, monthlyGross: "1" }))
        .status,
    ).toBe(404);
    expect(
      (await api.change(b.companyId, run.id, { action: "approve", expectedVersion: 1 })).status,
    ).toBe(404);
    expect((await api.csv(b.companyId, run.id)).status).toBe(404);
    as(null);
    expect((await api.rates(a.companyId)).status).toBe(401);
  });
});
