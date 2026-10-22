import { orNull } from "@/features/records/api";

/** Client-side shapes of the payroll API; the server calculates everything. */

export type PayrollCountry = "LV" | "LT" | "EE" | "PL";

export interface RatesItem {
  country: PayrollCountry;
  employeeSocialRate: string;
  employerSocialRate: string;
  incomeTaxRate: string;
  employeeHealthRate: string;
  isDefault: boolean;
  version: number;
}

export interface EmployeeItem {
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

export interface PayrollLineItem {
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
}

export interface PayrollRunItem {
  id: string;
  period: string;
  status: "draft" | "approved";
  approvedAt: string | null;
  version: number;
  lines: PayrollLineItem[];
}

export interface EmployeeDraft {
  firstName: string;
  lastName: string;
  position: string;
  email: string;
  taxCountry: PayrollCountry;
  employmentStart: string;
  employmentEnd: string;
  monthlyGross: string;
  monthlyAllowance: string;
  monthlyTaxCredit: string;
}

export function emptyEmployee(today: string, country: PayrollCountry = "LV"): EmployeeDraft {
  return {
    firstName: "",
    lastName: "",
    position: "",
    email: "",
    taxCountry: country,
    employmentStart: today,
    employmentEnd: "",
    monthlyGross: "",
    monthlyAllowance: "0",
    monthlyTaxCredit: "0",
  };
}

export function employeeDraftOf(e: EmployeeItem): EmployeeDraft {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    position: e.position ?? "",
    email: e.email ?? "",
    taxCountry: e.taxCountry,
    employmentStart: e.employmentStart,
    employmentEnd: e.employmentEnd ?? "",
    monthlyGross: e.monthlyGross,
    monthlyAllowance: e.monthlyAllowance,
    monthlyTaxCredit: e.monthlyTaxCredit,
  };
}

export function toEmployeeBody(d: EmployeeDraft) {
  return {
    firstName: d.firstName.trim(),
    lastName: d.lastName.trim(),
    position: orNull(d.position),
    email: orNull(d.email),
    taxCountry: d.taxCountry,
    employmentStart: d.employmentStart,
    employmentEnd: d.employmentEnd || null,
    monthlyGross: d.monthlyGross.trim(),
    monthlyAllowance: d.monthlyAllowance.trim() || "0",
    monthlyTaxCredit: d.monthlyTaxCredit.trim() || "0",
  };
}

const cents = (v: string) => {
  const [i = "0", f = ""] = v.split(".");
  return BigInt(i) * 100n + BigInt((f + "00").slice(0, 2));
};

/** Totals of a run per currency (gross, net, employer cost), exact to the cent. */
export function runTotals(lines: readonly PayrollLineItem[]) {
  const by = new Map<string, { gross: bigint; net: bigint; employerCost: bigint }>();
  for (const l of lines) {
    const t = by.get(l.currency) ?? { gross: 0n, net: 0n, employerCost: 0n };
    t.gross += cents(l.gross);
    t.net += cents(l.net);
    t.employerCost += cents(l.employerCost);
    by.set(l.currency, t);
  }
  const fmt = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
  return [...by.entries()].map(([currency, t]) => ({
    currency,
    gross: fmt(t.gross),
    net: fmt(t.net),
    employerCost: fmt(t.employerCost),
  }));
}
