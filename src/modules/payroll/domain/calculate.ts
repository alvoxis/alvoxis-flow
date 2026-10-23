/**
 * Monthly payroll calculation for one employee — a transparent aid, not an official tax
 * declaration. Rates are company settings (per country) that the accountant must check; the
 * defaults below are starting values only. Amounts are decimal strings with 2 decimals; rates are
 * percentages with up to 3 decimals. All arithmetic uses integer cents (bigint), rounding half up.
 *
 *   employee social  = gross × employeeSocialRate
 *   health           = (gross − employee social) × employeeHealthRate        (e.g. Poland)
 *   taxable          = max(0, gross − employee social − allowance)
 *   income tax       = max(0, taxable × incomeTaxRate − tax credit)
 *   net              = gross − employee social − health − income tax
 *   employer social  = gross × employerSocialRate
 *   employer cost    = gross + employer social
 */

export const PAYROLL_COUNTRIES = ["LV", "LT", "EE", "PL"] as const;
export type PayrollCountry = (typeof PAYROLL_COUNTRIES)[number];

export interface PayrollRates {
  employeeSocialRate: string;
  employerSocialRate: string;
  incomeTaxRate: string;
  employeeHealthRate: string;
}

/**
 * Starting values per country (2025 general rates as commonly published; special regimes,
 * thresholds, progressive brackets, caps and pension choices are not modelled). They must be
 * checked and adjusted in the payroll settings before use.
 */
export const DEFAULT_RATES: Record<PayrollCountry, PayrollRates> = {
  LV: {
    employeeSocialRate: "10.5",
    employerSocialRate: "23.59",
    incomeTaxRate: "25.5",
    employeeHealthRate: "0",
  },
  LT: {
    employeeSocialRate: "19.5",
    employerSocialRate: "1.77",
    incomeTaxRate: "20",
    employeeHealthRate: "0",
  },
  EE: {
    employeeSocialRate: "3.6",
    employerSocialRate: "33.8",
    incomeTaxRate: "22",
    employeeHealthRate: "0",
  },
  PL: {
    employeeSocialRate: "13.71",
    employerSocialRate: "20.48",
    incomeTaxRate: "12",
    employeeHealthRate: "9",
  },
};

export const CURRENCY_OF: Record<PayrollCountry, "EUR" | "PLN"> = {
  LV: "EUR",
  LT: "EUR",
  EE: "EUR",
  PL: "PLN",
};

export interface PayrollInput {
  gross: string;
  /** Monthly non-taxable amount (e.g. LV/EE basic allowance, PL deductible costs). */
  allowance: string;
  /** Monthly amount subtracted from the computed income tax (e.g. PL tax-reducing amount). */
  taxCredit: string;
}

export interface PayrollResult {
  gross: string;
  employeeSocial: string;
  health: string;
  taxable: string;
  incomeTax: string;
  net: string;
  employerSocial: string;
  employerCost: string;
}

export const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;
export const RATE = /^\d{1,2}(\.\d{1,3})?$/;

/** "1234.5" → 123450n cents. */
export function toCents(v: string): bigint {
  const [i = "0", f = ""] = v.split(".");
  return BigInt(i) * 100n + BigInt((f + "00").slice(0, 2));
}

export function fromCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

/** cents × rate% (rate with up to 3 decimals), rounded half up to cents. */
export function percentOf(cents: bigint, rate: string): bigint {
  const [i = "0", f = ""] = rate.split(".");
  const milli = BigInt(i) * 1000n + BigInt((f + "000").slice(0, 3)); // rate × 1000
  const scaled = cents * milli; // cents × rate × 1000, in hundredths of a percent… / 100000
  return (scaled + 50000n) / 100000n;
}

const max0 = (v: bigint) => (v < 0n ? 0n : v);

export function calculatePayroll(input: PayrollInput, rates: PayrollRates): PayrollResult {
  const gross = toCents(input.gross);
  const employeeSocial = percentOf(gross, rates.employeeSocialRate);
  const health = percentOf(gross - employeeSocial, rates.employeeHealthRate);
  const taxable = max0(gross - employeeSocial - toCents(input.allowance));
  const incomeTax = max0(percentOf(taxable, rates.incomeTaxRate) - toCents(input.taxCredit));
  const employerSocial = percentOf(gross, rates.employerSocialRate);
  return {
    gross: fromCents(gross),
    employeeSocial: fromCents(employeeSocial),
    health: fromCents(health),
    taxable: fromCents(taxable),
    incomeTax: fromCents(incomeTax),
    net: fromCents(gross - employeeSocial - health - incomeTax),
    employerSocial: fromCents(employerSocial),
    employerCost: fromCents(gross + employerSocial),
  };
}

/** Sum of 2-decimal amounts. */
export function sumAmounts(values: readonly string[]): string {
  return fromCents(values.reduce((a, v) => a + toCents(v), 0n));
}
