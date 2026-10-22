import "server-only";
import { and, asc, desc, eq, inArray, isNull, lte, or, gte } from "drizzle-orm";
import { z } from "zod";
import { type ValidationIssue } from "@/modules/documents/domain/validation";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { employees, payrollLines, payrollRates, payrollRuns } from "@/server/db/schema";
import {
  RecordNotFoundError,
  RecordStateError,
  RecordTakenError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";
import {
  AMOUNT,
  calculatePayroll,
  CURRENCY_OF,
  DEFAULT_RATES,
  PAYROLL_COUNTRIES,
  type PayrollCountry,
  type PayrollRates,
  RATE,
} from "../domain/calculate";

/**
 * Employees, payroll rates and monthly payroll runs (payroll.view to read, payroll.manage to
 * change). Salaries are sensitive: nothing here is visible without payroll.view, and audit
 * entries carry ids, periods and counts only — never names or amounts. A run copies each
 * employee's name, country, currency and the rates into its lines; an approved run is final.
 */

const trim2 = (v: string) => {
  const [i = "0", f = ""] = v.split(".");
  return `${i}.${(f + "00").slice(0, 2)}`;
};
const trimRate = (v: string) => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s: string) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// --- rates ----------------------------------------------------------------------------------

export interface RatesView extends PayrollRates {
  country: PayrollCountry;
  /** True while the company has not saved its own rates for this country. */
  isDefault: boolean;
  version: number;
}

async function ratesOf(db: DbOrTx, companyId: string): Promise<RatesView[]> {
  const rows = await db.select().from(payrollRates).where(eq(payrollRates.companyId, companyId));
  return PAYROLL_COUNTRIES.map((country) => {
    const r = rows.find((x) => x.country === country);
    return r
      ? {
          country,
          employeeSocialRate: trimRate(r.employeeSocialRate),
          employerSocialRate: trimRate(r.employerSocialRate),
          incomeTaxRate: trimRate(r.incomeTaxRate),
          employeeHealthRate: trimRate(r.employeeHealthRate),
          isDefault: false,
          version: r.version,
        }
      : { country, ...DEFAULT_RATES[country], isDefault: true, version: 0 };
  });
}

/** The rates per country, saved or default (payroll.view). */
export async function getPayrollRates(db: DbOrTx, actor: Actor, companyId: string) {
  await requireCompanyAccess(db, actor, companyId, "payroll.view");
  return ratesOf(db, companyId);
}

const ratesSchema = z.strictObject({
  country: z.enum(PAYROLL_COUNTRIES),
  /** 0 while the defaults are in use. */
  expectedVersion: z.number().int().min(0),
  employeeSocialRate: z.string().max(10),
  employerSocialRate: z.string().max(10),
  incomeTaxRate: z.string().max(10),
  employeeHealthRate: z.string().max(10),
});

/** Saves a country's rates (payroll.manage, version; 0 replaces the defaults). */
export async function setPayrollRates(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<RatesView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "payroll.manage");
    const data = ratesSchema.parse(input);
    const keys = [
      "employeeSocialRate",
      "employerSocialRate",
      "incomeTaxRate",
      "employeeHealthRate",
    ] as const;
    const values = Object.fromEntries(
      keys.map((k) => [k, data[k].trim().replace(",", ".")]),
    ) as unknown as PayrollRates;
    const issues: ValidationIssue[] = keys
      .filter((k) => !RATE.test(values[k]))
      .map((k) => ({ code: "payroll.rate.invalid", severity: "error", path: k }));
    if (issues.length) throw new RecordValidationError(issues);
    const [current] = await tx
      .select()
      .from(payrollRates)
      .where(and(eq(payrollRates.companyId, companyId), eq(payrollRates.country, data.country)))
      .for("update");
    if ((current?.version ?? 0) !== data.expectedVersion) throw new RecordVersionConflictError();
    if (current)
      await tx
        .update(payrollRates)
        .set({ ...values, version: current.version + 1 })
        .where(eq(payrollRates.id, current.id));
    else await tx.insert(payrollRates).values({ ...values, companyId, country: data.country });
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "payroll.rates_set",
      entityType: "payroll_rates",
      metadata: { country: data.country },
    });
    return (await ratesOf(tx, companyId)).find((r) => r.country === data.country)!;
  });
}

// --- employees ------------------------------------------------------------------------------

type EmployeeRow = typeof employees.$inferSelect;

export interface EmployeeView {
  id: string;
  firstName: string;
  lastName: string;
  position: string | null;
  email: string | null;
  taxCountry: PayrollCountry;
  currency: "EUR" | "PLN";
  employmentStart: string;
  employmentEnd: string | null;
  monthlyGross: string;
  monthlyAllowance: string;
  monthlyTaxCredit: string;
  archived: boolean;
  version: number;
}

const toEmployee = (r: EmployeeRow): EmployeeView => ({
  id: r.id,
  firstName: r.firstName,
  lastName: r.lastName,
  position: r.position,
  email: r.email,
  taxCountry: r.taxCountry as PayrollCountry,
  currency: CURRENCY_OF[r.taxCountry as PayrollCountry],
  employmentStart: r.employmentStart,
  employmentEnd: r.employmentEnd,
  monthlyGross: trim2(r.monthlyGross),
  monthlyAllowance: trim2(r.monthlyAllowance),
  monthlyTaxCredit: trim2(r.monthlyTaxCredit),
  archived: r.archivedAt !== null,
  version: r.version,
});

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional();

const employeeFields = {
  firstName: z.string().max(100),
  lastName: z.string().max(100),
  position: optText(100),
  email: optText(254),
  taxCountry: z.string().max(2),
  employmentStart: z.string().max(10),
  employmentEnd: z.string().max(10).nullable().optional(),
  monthlyGross: z.string().max(16),
  monthlyAllowance: z.string().max(16).optional(),
  monthlyTaxCredit: z.string().max(16).optional(),
};

type EmployeeEditable = Pick<
  EmployeeRow,
  | "firstName"
  | "lastName"
  | "position"
  | "email"
  | "taxCountry"
  | "employmentStart"
  | "employmentEnd"
  | "monthlyGross"
  | "monthlyAllowance"
  | "monthlyTaxCredit"
>;

const EMPLOYEE_KEYS: (keyof EmployeeEditable)[] = [
  "firstName",
  "lastName",
  "position",
  "email",
  "taxCountry",
  "employmentStart",
  "employmentEnd",
  "monthlyGross",
  "monthlyAllowance",
  "monthlyTaxCredit",
];

function validateEmployee(v: EmployeeEditable): EmployeeEditable {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
  const amount = (value: string, path: string) => {
    const s = value.trim().replace(",", ".");
    if (!AMOUNT.test(s)) {
      add("payroll.amount.invalid", path);
      return "0";
    }
    return trim2(s);
  };
  const out: EmployeeEditable = {
    ...v,
    firstName: v.firstName.trim(),
    lastName: v.lastName.trim(),
    taxCountry: v.taxCountry.trim().toUpperCase(),
    employmentEnd: v.employmentEnd || null,
    monthlyGross: amount(v.monthlyGross, "monthlyGross"),
    monthlyAllowance: amount(v.monthlyAllowance, "monthlyAllowance"),
    monthlyTaxCredit: amount(v.monthlyTaxCredit, "monthlyTaxCredit"),
  };
  if (!out.firstName) add("payroll.firstName.required", "firstName");
  if (!out.lastName) add("payroll.lastName.required", "lastName");
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email))
    add("payroll.email.invalid", "email");
  if (!(PAYROLL_COUNTRIES as readonly string[]).includes(out.taxCountry))
    add("payroll.country.invalid", "taxCountry");
  if (!isValidDate(out.employmentStart)) add("payroll.date.invalid", "employmentStart");
  if (out.employmentEnd !== null) {
    if (!isValidDate(out.employmentEnd)) add("payroll.date.invalid", "employmentEnd");
    else if (isValidDate(out.employmentStart) && out.employmentEnd < out.employmentStart)
      add("payroll.date.endBeforeStart", "employmentEnd");
  }
  if (issues.length) throw new RecordValidationError(issues);
  return out;
}

/** Employees by name (payroll.view). */
export async function listEmployees(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<EmployeeView[]> {
  await requireCompanyAccess(db, actor, companyId, "payroll.view");
  const rows = await db
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.companyId, companyId),
        opts.includeArchived ? undefined : isNull(employees.archivedAt),
      ),
    )
    .orderBy(
      asc(employees.archivedAt),
      asc(employees.lastName),
      asc(employees.firstName),
      asc(employees.id),
    );
  return rows.map(toEmployee);
}

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Adds an employee (payroll.manage). Every invalid field is reported at once (422). */
export async function createEmployee(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<EmployeeView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "payroll.manage");
    const data = z.strictObject(employeeFields).parse(input);
    const values = validateEmployee({
      position: null,
      email: null,
      employmentEnd: null,
      monthlyAllowance: "0",
      monthlyTaxCredit: "0",
      ...(defined(data) as Partial<EmployeeEditable>),
    } as EmployeeEditable);
    const [row] = await tx
      .insert(employees)
      .values({ ...values, companyId })
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "employee.created",
      entityType: "employee",
      entityId: row!.id,
      metadata: { taxCountry: row!.taxCountry },
    });
    return toEmployee(row!);
  });
}

/** Edits, archives or restores an employee (payroll.manage, version). */
export async function updateEmployee(
  db: Database,
  actor: Actor,
  companyId: string,
  id: string,
  input: unknown,
): Promise<EmployeeView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "payroll.manage");
    const data = z
      .strictObject({
        ...Object.fromEntries(
          Object.entries(employeeFields).map(([k, v]) => [k, (v as z.ZodType).optional()]),
        ),
        expectedVersion: z.number().int().positive(),
        archived: z.boolean().optional(),
      })
      .parse(input) as Partial<EmployeeEditable> & { expectedVersion: number; archived?: boolean };
    const [current] = await tx
      .select()
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.companyId, companyId)))
      .for("update");
    if (!current) throw new RecordNotFoundError();
    if (current.version !== data.expectedVersion) throw new RecordVersionConflictError();
    const { expectedVersion: _v, archived, ...patch } = data;
    const next = validateEmployee({ ...current, ...defined(patch) });
    const archivedAt =
      archived === undefined
        ? current.archivedAt
        : archived
          ? (current.archivedAt ?? new Date())
          : null;
    const changed: string[] = EMPLOYEE_KEYS.filter((k) =>
      k.startsWith("monthly")
        ? trim2(String(next[k])) !== trim2(String(current[k]))
        : next[k] !== current[k],
    );
    if ((archivedAt === null) !== (current.archivedAt === null)) changed.push("archived");
    if (!changed.length) return toEmployee(current);
    const [row] = await tx
      .update(employees)
      .set({
        ...Object.fromEntries(EMPLOYEE_KEYS.map((k) => [k, next[k]])),
        archivedAt,
        version: current.version + 1,
      })
      .where(and(eq(employees.id, id), eq(employees.companyId, companyId)))
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: changed.includes("archived")
        ? archivedAt
          ? "employee.archived"
          : "employee.restored"
        : "employee.updated",
      entityType: "employee",
      entityId: id,
      metadata: { changed, version: row!.version },
    });
    return toEmployee(row!);
  });
}

// --- runs -----------------------------------------------------------------------------------

type LineRow = typeof payrollLines.$inferSelect;
type RunRow = typeof payrollRuns.$inferSelect;

export interface PayrollLineView {
  id: string;
  employeeId: string;
  employeeName: string;
  taxCountry: PayrollCountry;
  currency: "EUR" | "PLN";
  gross: string;
  allowance: string;
  taxCredit: string;
  employeeSocial: string;
  health: string;
  taxable: string;
  incomeTax: string;
  net: string;
  employerSocial: string;
  employerCost: string;
  rates: PayrollRates;
}

export interface PayrollRunView {
  id: string;
  period: string;
  status: RunRow["status"];
  approvedAt: string | null;
  version: number;
  lines: PayrollLineView[];
}

const toLine = (r: LineRow): PayrollLineView => ({
  id: r.id,
  employeeId: r.employeeId,
  employeeName: r.employeeName,
  taxCountry: r.taxCountry as PayrollCountry,
  currency: r.currency as "EUR" | "PLN",
  gross: trim2(r.gross),
  allowance: trim2(r.allowance),
  taxCredit: trim2(r.taxCredit),
  employeeSocial: trim2(r.employeeSocial),
  health: trim2(r.health),
  taxable: trim2(r.taxable),
  incomeTax: trim2(r.incomeTax),
  net: trim2(r.net),
  employerSocial: trim2(r.employerSocial),
  employerCost: trim2(r.employerCost),
  rates: r.rates as PayrollRates,
});

async function runView(db: DbOrTx, run: RunRow): Promise<PayrollRunView> {
  const lines = await db
    .select()
    .from(payrollLines)
    .where(and(eq(payrollLines.companyId, run.companyId), eq(payrollLines.runId, run.id)))
    .orderBy(asc(payrollLines.employeeName), asc(payrollLines.id));
  return {
    id: run.id,
    period: run.period,
    status: run.status,
    approvedAt: run.approvedAt?.toISOString() ?? null,
    version: run.version,
    lines: lines.map(toLine),
  };
}

/** Runs, newest period first, with their lines (payroll.view). */
export async function listPayrollRuns(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<PayrollRunView[]> {
  await requireCompanyAccess(db, actor, companyId, "payroll.view");
  const runs = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.companyId, companyId))
    .orderBy(desc(payrollRuns.period))
    .limit(36);
  return Promise.all(runs.map((r) => runView(db, r)));
}

/** One run with its lines (payroll.view); unknown → 404. */
export async function getPayrollRun(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  runId: string,
): Promise<PayrollRunView> {
  await requireCompanyAccess(db, actor, companyId, "payroll.view");
  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, companyId)));
  if (!run) throw new RecordNotFoundError();
  return runView(db, run);
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

function periodBounds(period: string) {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(last).padStart(2, "0")}` };
}

/** (Re)writes the lines of a draft run from the active employees and the current rates. */
async function fillRun(
  tx: DbOrTx,
  companyId: string,
  run: RunRow,
  overrides = new Map<string, string>(),
) {
  const { first, last } = periodBounds(run.period);
  const staff = await tx
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.companyId, companyId),
        isNull(employees.archivedAt),
        lte(employees.employmentStart, last),
        or(isNull(employees.employmentEnd), gte(employees.employmentEnd, first)),
      ),
    );
  if (!staff.length)
    throw new RecordValidationError([
      { code: "payroll.run.noEmployees", severity: "error", path: "period" },
    ]);
  const rates = await ratesOf(tx, companyId);
  await tx
    .delete(payrollLines)
    .where(and(eq(payrollLines.companyId, companyId), eq(payrollLines.runId, run.id)));
  await tx.insert(payrollLines).values(
    staff.map((e) => {
      const country = e.taxCountry as PayrollCountry;
      const r = rates.find((x) => x.country === country)!;
      const used: PayrollRates = {
        employeeSocialRate: r.employeeSocialRate,
        employerSocialRate: r.employerSocialRate,
        incomeTaxRate: r.incomeTaxRate,
        employeeHealthRate: r.employeeHealthRate,
      };
      const input = {
        gross: overrides.get(e.id) ?? trim2(e.monthlyGross),
        allowance: trim2(e.monthlyAllowance),
        taxCredit: trim2(e.monthlyTaxCredit),
      };
      return {
        companyId,
        runId: run.id,
        employeeId: e.id,
        employeeName: `${e.firstName} ${e.lastName}`,
        taxCountry: country,
        currency: CURRENCY_OF[country],
        allowance: input.allowance,
        taxCredit: input.taxCredit,
        ...calculatePayroll(input, used),
        rates: used,
      };
    }),
  );
  return staff.length;
}

/**
 * Starts the run of a month (payroll.manage) from the employees employed in it and the current
 * rates. One run per month (409 period_taken); no employees → 422.
 */
export async function createPayrollRun(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<PayrollRunView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "payroll.manage");
    const { period } = z.strictObject({ period: z.string().max(7) }).parse(input);
    if (!PERIOD.test(period))
      throw new RecordValidationError([
        { code: "payroll.period.invalid", severity: "error", path: "period" },
      ]);
    const [run] = await tx
      .insert(payrollRuns)
      .values({ companyId, period, createdByUserId: actor.userId })
      .onConflictDoNothing({ target: [payrollRuns.companyId, payrollRuns.period] })
      .returning();
    if (!run) throw new RecordTakenError("period_taken");
    const count = await fillRun(tx, companyId, run);
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "payroll.run_created",
      entityType: "payroll_run",
      entityId: run.id,
      metadata: { period, lines: count },
    });
    return runView(tx, run);
  });
}

const changeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("recalculate"),
    expectedVersion: z.number().int().positive(),
  }),
  z.strictObject({ action: z.literal("approve"), expectedVersion: z.number().int().positive() }),
  z.strictObject({
    action: z.literal("setGross"),
    expectedVersion: z.number().int().positive(),
    employeeId: z.uuid(),
    gross: z.string().max(16),
  }),
]);

/**
 * Changes a draft run (payroll.manage, version): `recalculate` (current employees and rates;
 * changed gross amounts are kept), `setGross` (one employee's gross for this month, e.g. a bonus
 * or a partial month) or `approve` (final). Approved runs → 409 invalid_state payroll.approved.
 */
export async function changePayrollRun(
  db: Database,
  actor: Actor,
  companyId: string,
  runId: string,
  input: unknown,
): Promise<PayrollRunView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "payroll.manage");
    const data = changeSchema.parse(input);
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, companyId)))
      .for("update");
    if (!run) throw new RecordNotFoundError();
    if (run.version !== data.expectedVersion) throw new RecordVersionConflictError();
    if (run.status !== "draft") throw new RecordStateError("payroll.approved");
    // Gross amounts that differ from the employees' monthly salary survive a recalculation.
    const current = await tx
      .select({ employeeId: payrollLines.employeeId, gross: payrollLines.gross })
      .from(payrollLines)
      .where(and(eq(payrollLines.companyId, companyId), eq(payrollLines.runId, runId)));
    const salaries = current.length
      ? await tx
          .select({ id: employees.id, gross: employees.monthlyGross })
          .from(employees)
          .where(
            and(
              eq(employees.companyId, companyId),
              inArray(
                employees.id,
                current.map((c) => c.employeeId),
              ),
            ),
          )
      : [];
    const overrides = new Map(
      current
        .filter(
          (c) => trim2(c.gross) !== trim2(salaries.find((s) => s.id === c.employeeId)?.gross ?? ""),
        )
        .map((c) => [c.employeeId, trim2(c.gross)]),
    );
    if (data.action === "setGross") {
      const gross = data.gross.trim().replace(",", ".");
      if (!AMOUNT.test(gross))
        throw new RecordValidationError([
          { code: "payroll.amount.invalid", severity: "error", path: "gross" },
        ]);
      if (!current.some((c) => c.employeeId === data.employeeId)) throw new RecordNotFoundError();
      overrides.set(data.employeeId, trim2(gross));
    }
    if (data.action !== "approve") await fillRun(tx, companyId, run, overrides);
    const [row] = await tx
      .update(payrollRuns)
      .set({
        version: run.version + 1,
        ...(data.action === "approve"
          ? { status: "approved" as const, approvedAt: new Date() }
          : {}),
      })
      .where(eq(payrollRuns.id, runId))
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: `payroll.run_${data.action === "setGross" ? "gross_set" : data.action === "approve" ? "approved" : "recalculated"}`,
      entityType: "payroll_run",
      entityId: runId,
      metadata: { period: run.period, version: row!.version },
    });
    return runView(tx, row!);
  });
}

/** Deletes a draft run (payroll.manage, version); approved runs stay. */
export async function deletePayrollRun(
  db: Database,
  actor: Actor,
  companyId: string,
  runId: string,
  expectedVersion: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "payroll.manage");
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, companyId)))
      .for("update");
    if (!run) throw new RecordNotFoundError();
    if (run.version !== expectedVersion) throw new RecordVersionConflictError();
    if (run.status !== "draft") throw new RecordStateError("payroll.approved");
    await tx.delete(payrollRuns).where(eq(payrollRuns.id, runId));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "payroll.run_deleted",
      entityType: "payroll_run",
      entityId: runId,
      metadata: { period: run.period },
    });
  });
}

/** CSV of a run (payroll.view): one row per employee, semicolon-separated, UTF-8 with BOM. */
export async function payrollRunCsv(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  runId: string,
): Promise<{ filename: string; body: string }> {
  const run = await getPayrollRun(db, actor, companyId, runId);
  const header = [
    "employee",
    "country",
    "currency",
    "gross",
    "employee_social",
    "health",
    "allowance",
    "taxable",
    "income_tax",
    "tax_credit",
    "net",
    "employer_social",
    "employer_cost",
  ];
  // Quote every text cell; a leading = + - @ is neutralised (spreadsheet formula injection).
  const cell = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  const rows = run.lines.map((l) =>
    [
      cell(l.employeeName),
      l.taxCountry,
      l.currency,
      l.gross,
      l.employeeSocial,
      l.health,
      l.allowance,
      l.taxable,
      l.incomeTax,
      l.taxCredit,
      l.net,
      l.employerSocial,
      l.employerCost,
    ].join(";"),
  );
  return {
    filename: `payroll-${run.period}.csv`,
    body: `﻿${[header.join(";"), ...rows].join("\r\n")}\r\n`,
  };
}
