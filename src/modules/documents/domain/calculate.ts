import Decimal from "decimal.js";
import { convert, Money, RoundingMode } from "@/lib/money";
import {
  type DocumentDraft,
  type DocumentLine,
  type DocumentTotals,
  type TaxSummaryRow,
} from "./types";

const D = Decimal.clone({ precision: 40 });
const HUNDRED = new D(100);

/**
 * How tax is rounded.
 * - per_group: tax is computed once per tax category on the sum of line nets (default).
 * - per_line:  tax is computed and rounded per line, then summed.
 * Which policy a company must use is a legal/accounting decision; both are offered.
 */
export type TaxRoundingPolicy = "per_group" | "per_line";

export interface CalculationOptions {
  taxRounding?: TaxRoundingPolicy;
  rounding?: RoundingMode;
}

/** Net amount of one line, rounded to currency minor units. */
export function lineNet(
  line: DocumentLine,
  draft: Pick<DocumentDraft, "currency">,
  rounding: RoundingMode = RoundingMode.HALF_UP,
): Money {
  if (line.unitPrice === null) throw new Error(`Line ${line.id} has no unit price`);
  const discount = new D(line.discountPercent ?? "0");
  const factor = HUNDRED.minus(discount).dividedBy(HUNDRED).toFixed();
  return Money.of(line.unitPrice, draft.currency)
    .multiply(line.quantity)
    .multiply(factor)
    .round(rounding);
}

function taxOn(base: Money, ratePercent: string, rounding: RoundingMode): Money {
  return base.multiply(new D(ratePercent).dividedBy(HUNDRED).toFixed()).round(rounding);
}

/**
 * Computes line nets, the tax summary per category and document totals in the document's own
 * currency. Amounts in other currencies are only produced from an attached rate snapshot and are
 * never mixed with document-currency totals.
 */
export function calculateTotals(
  draft: DocumentDraft,
  options: CalculationOptions = {},
): DocumentTotals {
  const policy = options.taxRounding ?? "per_group";
  const rounding: RoundingMode = options.rounding ?? RoundingMode.HALF_UP;
  const { currency } = draft;

  const groups = new Map<
    string,
    { row: Omit<TaxSummaryRow, "taxableAmount" | "taxAmount">; base: Money; tax: Money }
  >();
  const lines = draft.lines.map((line) => {
    const net = lineNet(line, draft, rounding);
    const cat = line.taxCategory;
    if (!cat) throw new Error(`Line ${line.id} has no tax category`);
    const key = `${cat.code}|${cat.kind}|${cat.ratePercent}`;
    const group = groups.get(key) ?? {
      row: {
        code: cat.code,
        kind: cat.kind,
        ratePercent: cat.ratePercent,
        label: cat.label,
        note: cat.note,
      },
      base: Money.zero(currency),
      tax: Money.zero(currency),
    };
    group.base = group.base.add(net);
    if (policy === "per_line" && cat.kind === "standard") {
      group.tax = group.tax.add(taxOn(net, cat.ratePercent, rounding));
    }
    groups.set(key, group);
    return { lineId: line.id, net };
  });

  const taxSummary: TaxSummaryRow[] = [...groups.values()].map((g) => {
    const tax =
      g.row.kind !== "standard"
        ? Money.zero(currency)
        : policy === "per_group"
          ? taxOn(g.base, g.row.ratePercent, rounding)
          : g.tax;
    const row: TaxSummaryRow = {
      ...g.row,
      taxableAmount: g.base.toFixed(),
      taxAmount: tax.toFixed(),
    };
    if (row.note === undefined) delete row.note;
    return row;
  });

  const netTotal = lines.reduce((acc, l) => acc.add(l.net), Money.zero(currency));
  const taxTotal = taxSummary.reduce(
    (acc, r) => acc.add(Money.of(r.taxAmount, currency)),
    Money.zero(currency),
  );
  const grossTotal = netTotal.add(taxTotal);

  const totals: DocumentTotals = {
    currency,
    lines: lines.map((l) => ({ lineId: l.lineId, net: l.net.toFixed() })),
    taxSummary,
    netTotal: netTotal.toFixed(),
    taxTotal: taxTotal.toFixed(),
    grossTotal: grossTotal.toFixed(),
  };

  if (draft.exchangeRate) {
    const rate = draft.exchangeRate;
    if (rate.from !== currency) {
      throw new Error(`Exchange rate converts from ${rate.from}, document currency is ${currency}`);
    }
    // Net and tax are converted separately and gross is their sum, so the converted figures
    // always add up. Converting line by line could differ by rounding; this is informational.
    const convertedNet = convert(netTotal, rate, rounding);
    const convertedTax = convert(taxTotal, rate, rounding);
    totals.converted = {
      currency: rate.to,
      rate,
      netTotal: convertedNet.toFixed(),
      taxTotal: convertedTax.toFixed(),
      grossTotal: convertedNet.add(convertedTax).toFixed(),
    };
  }

  return totals;
}
