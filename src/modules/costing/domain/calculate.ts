import Decimal from "decimal.js";
import { z } from "zod";

/**
 * Full product cost calculation (pure; decimal arithmetic, no floats). A calculation describes one
 * batch of `quantity` units and its cost lines. Each line is one of:
 *
 * - `total`: an amount for the whole batch (delivery, insurance, packaging run, overhead share …);
 * - `per_unit`: an amount per unit (purchase price, materials per piece …), × quantity;
 * - `piecework`: pieces × rate (piecework pay for a step; pieces default to the batch quantity);
 * - `percent`: a percentage of the customs value (purchase + delivery + insurance lines), for
 *   duties. The rate is ALWAYS entered by the user; nothing here knows a duty or tax rate, and a
 *   percentage line that is not marked verified is reported as needing verification.
 *
 * Amounts must exclude recoverable VAT (input VAT the company deducts is not a cost); only
 * non-recoverable taxes and fees belong in `non_recoverable_tax`. Results are rounded at the end
 * only: totals to cents, the unit cost to 4 decimals, percentages to 2, half up.
 *
 * Margin and markup are different: margin = profit ÷ price, markup = profit ÷ cost.
 */

export const COST_CATEGORIES = [
  "purchase",
  "delivery",
  "insurance",
  "customs_duty",
  "non_recoverable_tax",
  "packaging",
  "materials",
  "labor",
  "piecework",
  "overhead",
  "other",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/** Lines that make up the customs value a `percent` line is applied to. */
const CUSTOMS_VALUE: ReadonlySet<CostCategory> = new Set(["purchase", "delivery", "insurance"]);

const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;
const decimal = (max: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(",", "."))
    .refine((v) => DECIMAL.test(v), "decimal")
    // Only well-formed values are compared (a malformed one is reported once, above).
    .refine((v) => !DECIMAL.test(v) || new Decimal(v).lte(max), "too_large");

export const costLineSchema = z.strictObject({
  category: z.enum(COST_CATEGORIES),
  label: z.string().trim().max(120).default(""),
  basis: z.enum(["total", "per_unit", "piecework", "percent"]),
  /** total / per_unit: the amount; piecework: the rate per piece; percent: the percentage. */
  amount: decimal(1e12),
  /** piecework: number of pieces (default: the batch quantity). */
  pieces: decimal(1e9).nullable().optional(),
  /** percent lines: the user confirmed the rate against an official source. */
  verified: z.boolean().optional(),
});

export const calculationInputSchema = z
  .strictObject({
    currency: z.enum(["EUR", "PLN"]),
    quantity: decimal(1e9).refine((v) => !DECIMAL.test(v) || new Decimal(v).gt(0), "positive"),
    lines: z.array(costLineSchema).max(60),
    /** Net sale price per unit to evaluate (optional). */
    salePrice: decimal(1e12).nullable().optional(),
    /** Target margin in percent (0 ≤ m < 100) to suggest a price (optional). */
    targetMarginPercent: decimal(99.99).nullable().optional(),
    /** Other quantities and prices to compare (optional). */
    scenarios: z
      .array(
        z.strictObject({
          label: z.string().trim().max(60).default(""),
          quantity: decimal(1e9).refine(
            (v) => !DECIMAL.test(v) || new Decimal(v).gt(0),
            "positive",
          ),
          salePrice: decimal(1e12).nullable().optional(),
        }),
      )
      .max(6)
      .default([]),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      if (l.basis === "percent" && DECIMAL.test(l.amount) && new Decimal(l.amount).gt(1000))
        ctx.addIssue({ code: "custom", path: ["lines", i, "amount"], message: "percent_range" });
    });
  });

export type CalculationInput = z.input<typeof calculationInputSchema>;
export type ParsedCalculation = z.output<typeof calculationInputSchema>;

export interface LineResult {
  index: number;
  category: CostCategory;
  label: string;
  total: string;
  perUnit: string;
  /** Share of the total cost, percent. */
  share: string;
  needsVerification: boolean;
}

export interface PricingResult {
  salePrice: string;
  profitPerUnit: string;
  expectedProfit: string;
  /** null when the price is zero. */
  marginPercent: string | null;
  /** null when the unit cost is zero. */
  markupPercent: string | null;
  revenue: string;
}

export interface ScenarioResult {
  label: string;
  quantity: string;
  totalCost: string;
  unitCost: string;
  pricing: PricingResult | null;
}

export interface CalculationResult {
  currency: "EUR" | "PLN";
  quantity: string;
  totalCost: string;
  unitCost: string;
  lines: LineResult[];
  byCategory: { category: CostCategory; total: string; share: string }[];
  pricing: PricingResult | null;
  /** Price per unit that reaches the target margin, when one was given. */
  priceForTargetMargin: string | null;
  scenarios: ScenarioResult[];
  /** Lines whose rate needs checking against an official source (duties, taxes). */
  warnings: { index: number; code: "unverified_rate" | "percent_without_customs_value" }[];
}

const D = (v: string | number) => new Decimal(v);
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const unit = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
const pct = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** Line totals for a batch of `quantity` (full precision). */
function lineTotals(lines: ParsedCalculation["lines"], quantity: Decimal): Decimal[] {
  const totals: Decimal[] = lines.map((l) => {
    switch (l.basis) {
      case "total":
        return D(l.amount);
      case "per_unit":
        return D(l.amount).times(quantity);
      case "piecework":
        return D(l.amount).times(l.pieces ? D(l.pieces) : quantity);
      case "percent":
        return D(0);
    }
  });
  const customsValue = lines.reduce(
    (acc, l, i) =>
      CUSTOMS_VALUE.has(l.category) && l.basis !== "percent" ? acc.plus(totals[i]!) : acc,
    D(0),
  );
  lines.forEach((l, i) => {
    if (l.basis === "percent") totals[i] = customsValue.times(D(l.amount)).div(100);
  });
  return totals;
}

export function priceForMargin(unitCost: Decimal, marginPercent: Decimal): Decimal {
  return unitCost.div(D(1).minus(marginPercent.div(100)));
}

function pricingOf(
  unitCost: Decimal,
  quantity: Decimal,
  salePrice: string | null | undefined,
): PricingResult | null {
  if (salePrice === null || salePrice === undefined || salePrice === "") return null;
  const price = D(salePrice);
  const profit = price.minus(unitCost);
  return {
    salePrice: unit(price),
    profitPerUnit: unit(profit),
    expectedProfit: money(profit.times(quantity)),
    marginPercent: price.isZero() ? null : pct(profit.div(price).times(100)),
    markupPercent: unitCost.isZero() ? null : pct(profit.div(unitCost).times(100)),
    revenue: money(price.times(quantity)),
  };
}

export function calculateCost(raw: CalculationInput): CalculationResult {
  const input = calculationInputSchema.parse(raw);
  const quantity = D(input.quantity);
  const totals = lineTotals(input.lines, quantity);
  const total = totals.reduce((a, b) => a.plus(b), D(0));
  const unitCost = total.div(quantity);
  const share = (v: Decimal) => (total.isZero() ? "0.00" : pct(v.div(total).times(100)));

  const byCat = new Map<CostCategory, Decimal>();
  input.lines.forEach((l, i) =>
    byCat.set(l.category, (byCat.get(l.category) ?? D(0)).plus(totals[i]!)),
  );

  const hasCustomsValue = input.lines.some(
    (l) => CUSTOMS_VALUE.has(l.category) && l.basis !== "percent",
  );
  const warnings: CalculationResult["warnings"] = [];
  input.lines.forEach((l, i) => {
    if (l.basis !== "percent") return;
    if (!l.verified) warnings.push({ index: i, code: "unverified_rate" });
    if (!hasCustomsValue) warnings.push({ index: i, code: "percent_without_customs_value" });
  });

  const target = input.targetMarginPercent ? D(input.targetMarginPercent) : null;
  return {
    currency: input.currency,
    quantity: quantity.toFixed(),
    totalCost: money(total),
    unitCost: unit(unitCost),
    lines: input.lines.map((l, i) => ({
      index: i,
      category: l.category,
      label: l.label,
      total: money(totals[i]!),
      perUnit: unit(totals[i]!.div(quantity)),
      share: share(totals[i]!),
      needsVerification: l.basis === "percent" && !l.verified,
    })),
    byCategory: COST_CATEGORIES.filter((c) => byCat.has(c)).map((c) => ({
      category: c,
      total: money(byCat.get(c)!),
      share: share(byCat.get(c)!),
    })),
    pricing: pricingOf(unitCost, quantity, input.salePrice),
    priceForTargetMargin: target ? unit(priceForMargin(unitCost, target)) : null,
    scenarios: input.scenarios.map((s) => {
      const q = D(s.quantity);
      const t = lineTotals(input.lines, q).reduce((a, b) => a.plus(b), D(0));
      const u = t.div(q);
      return {
        label: s.label,
        quantity: q.toFixed(),
        totalCost: money(t),
        unitCost: unit(u),
        pricing: pricingOf(u, q, s.salePrice ?? input.salePrice),
      };
    }),
    warnings,
  };
}
