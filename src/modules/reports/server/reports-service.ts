import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { previousRange } from "@/features/dashboard/range";
import { isCurrencyCode, Money } from "@/lib/money";
import { businessDashboard } from "@/modules/dashboard/server/business-dashboard";
import { ageingBucket } from "@/modules/finance/domain/receivables";
import { invoiceBalances, todayIso } from "@/modules/finance/server/payment-service";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type DbOrTx } from "@/server/db/client";

/**
 * Reports of one company for a period. Each report is a table of plain values (decimal strings,
 * dates, codes) built from recorded data through the same permission checks as the rest of the
 * application, so the page and its CSV export can never show more than the user may see.
 * Amounts are per currency and never converted.
 */

export const REPORTS = ["pnl", "receivables", "expenses", "vat", "margins", "stock"] as const;
export type ReportId = (typeof REPORTS)[number];

export interface ReportTable {
  id: ReportId;
  /** Column keys (translated by the page; also the CSV header). */
  columns: string[];
  /** Columns holding amounts or numbers (right-aligned). */
  numeric: string[];
  rows: string[][];
  /** Totals per currency where meaningful, same columns. */
  totals: string[][];
}

const PERMISSIONS: Record<ReportId, Parameters<typeof requireCompanyAccess>[3]> = {
  pnl: ["analytics.view", "documents.view", "finance.view"],
  receivables: ["documents.view", "finance.view"],
  expenses: ["finance.view"],
  vat: ["documents.view", "finance.view"],
  margins: ["products.view"],
  stock: ["inventory.view"],
};

const m = (v: string, c: string) => (isCurrencyCode(c) ? Money.of(v, c).toFixed() : v);

async function pnl(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  r: { from: string; to: string },
): Promise<ReportTable> {
  const d = await businessDashboard(db, actor, companyId, r);
  const rows: string[][] = [];
  const totals: string[][] = [];
  for (const c of d.currencies) {
    for (const p of d.series[c] ?? []) {
      const result = Money.of(p.revenue, c).subtract(Money.of(p.expenses, c));
      if (
        p.revenue === "0.00" &&
        p.expenses === "0.00" &&
        p.cashIn === "0.00" &&
        p.cashOut === "0.00"
      )
        continue;
      rows.push([p.key, c, p.revenue, p.expenses, result.toFixed(), p.cashIn, p.cashOut]);
    }
    const f = d.figures.find((x) => x.currency === c)!;
    totals.push(["total", c, f.revenue, f.expenses, f.result, f.cashIn, f.cashOut]);
  }
  return {
    id: "pnl",
    columns: ["period", "currency", "revenue", "expenses", "result", "cashIn", "cashOut"],
    numeric: ["revenue", "expenses", "result", "cashIn", "cashOut"],
    rows,
    totals,
  };
}

async function receivables(db: DbOrTx, actor: Actor, companyId: string): Promise<ReportTable> {
  const today = todayIso();
  const open = (await invoiceBalances(db, actor, companyId, { asOf: today })).filter(
    (b) => b.status === "unpaid" || b.status === "partially_paid",
  );
  const rows = open
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.issueDate.localeCompare(b.issueDate))
    .map((b) => [
      b.number ?? "",
      b.buyerName ?? "",
      b.issueDate,
      b.dueDate ?? "",
      b.currency,
      b.grossTotal,
      b.paid,
      b.balance,
      String(b.daysOverdue),
      ageingBucket(b.daysOverdue),
    ]);
  const totals = (["EUR", "PLN"] as const)
    .map((c) => {
      const mine = open.filter((b) => b.currency === c);
      if (!mine.length) return null;
      const sum = (k: "grossTotal" | "paid" | "balance") =>
        mine.reduce((a, b) => a.add(Money.of(b[k], c)), Money.zero(c)).toFixed();
      return ["total", "", "", "", c, sum("grossTotal"), sum("paid"), sum("balance"), "", ""];
    })
    .filter((x): x is string[] => x !== null);
  return {
    id: "receivables",
    columns: [
      "number",
      "customer",
      "issueDate",
      "dueDate",
      "currency",
      "gross",
      "paid",
      "balance",
      "daysOverdue",
      "ageing",
    ],
    numeric: ["gross", "paid", "balance", "daysOverdue"],
    rows,
    totals,
  };
}

async function expenses(
  db: DbOrTx,
  companyId: string,
  r: { from: string; to: string },
): Promise<ReportTable> {
  const prev = previousRange(r);
  const cost = sql`case when tax_recoverable then net_amount else net_amount + tax_amount end`;
  const res = await db.execute<{
    currency: string;
    category: string;
    current: string;
    previous: string;
    n: number;
  }>(sql`
    select currency::text as currency, category,
           coalesce(sum(${cost}) filter (where expense_date between ${r.from}::date and ${r.to}::date), 0)::text as current,
           coalesce(sum(${cost}) filter (where expense_date between ${prev.from}::date and ${prev.to}::date), 0)::text as previous,
           count(*) filter (where expense_date between ${r.from}::date and ${r.to}::date)::int as n
    from expenses where company_id = ${companyId} and expense_date between ${prev.from}::date and ${r.to}::date
    group by 1, 2 order by 1, 3::numeric desc`);
  const rows = res.rows.map((x) => {
    const change = new Decimal(x.current).minus(x.previous);
    const pct = new Decimal(x.previous).isZero()
      ? ""
      : change.div(new Decimal(x.previous)).times(100).toDecimalPlaces(1).toFixed(1);
    return [
      x.category,
      x.currency,
      String(x.n),
      m(x.current, x.currency),
      m(x.previous, x.currency),
      m(change.toFixed(), x.currency),
      pct,
    ];
  });
  const totals = (["EUR", "PLN"] as const)
    .map((c) => {
      const mine = res.rows.filter((x) => x.currency === c);
      if (!mine.length) return null;
      const s = (k: "current" | "previous") =>
        mine.reduce((a, x) => a.add(Money.of(x[k], c)), Money.zero(c));
      return [
        "total",
        c,
        String(mine.reduce((a, x) => a + x.n, 0)),
        s("current").toFixed(),
        s("previous").toFixed(),
        s("current").subtract(s("previous")).toFixed(),
        "",
      ];
    })
    .filter((x): x is string[] => x !== null);
  return {
    id: "expenses",
    columns: ["category", "currency", "count", "cost", "previousCost", "change", "changePercent"],
    numeric: ["count", "cost", "previousCost", "change", "changePercent"],
    rows,
    totals,
  };
}

/**
 * VAT summary: output tax from the frozen tax summaries of issued invoices and credit notes dated
 * in the period, per currency and tax category; input tax from recorded expenses marked
 * recoverable. A summary of recorded figures to prepare a return, not a declaration.
 */
async function vat(
  db: DbOrTx,
  companyId: string,
  r: { from: string; to: string },
): Promise<ReportTable> {
  const [out, input] = await Promise.all([
    db.execute<{
      currency: string;
      code: string;
      kind: string;
      rate: string;
      taxable: string;
      tax: string;
    }>(sql`
      select d.currency::text as currency, s->>'code' as code, s->>'kind' as kind, s->>'ratePercent' as rate,
             sum((s->>'taxableAmount')::numeric)::text as taxable, sum((s->>'taxAmount')::numeric)::text as tax
      from documents d, jsonb_array_elements(coalesce(d.tax_summary, '[]'::jsonb)) s
      where d.company_id = ${companyId} and d.status = 'issued' and d.type in ('invoice', 'credit_note')
        and d.issue_date between ${r.from}::date and ${r.to}::date
      group by 1, 2, 3, 4 order by 1, 4::numeric desc, 2`),
    db.execute<{ currency: string; net: string; tax: string }>(sql`
      select currency::text as currency, sum(net_amount)::text as net, sum(tax_amount)::text as tax
      from expenses where company_id = ${companyId} and tax_recoverable and tax_amount > 0
        and expense_date between ${r.from}::date and ${r.to}::date
      group by 1 order by 1`),
  ]);
  const rows: string[][] = [
    ...out.rows.map((x) => [
      "output",
      x.currency,
      x.code,
      x.kind,
      x.rate,
      m(x.taxable, x.currency),
      m(x.tax, x.currency),
    ]),
    ...input.rows.map((x) => [
      "input",
      x.currency,
      "",
      "recorded_expenses",
      "",
      m(x.net, x.currency),
      m(x.tax, x.currency),
    ]),
  ];
  const totals = (["EUR", "PLN"] as const)
    .map((c) => {
      const o = out.rows
        .filter((x) => x.currency === c)
        .reduce((a, x) => a.add(Money.of(x.tax, c)), Money.zero(c));
      const i = input.rows
        .filter((x) => x.currency === c)
        .reduce((a, x) => a.add(Money.of(x.tax, c)), Money.zero(c));
      if (o.isZero() && i.isZero()) return null;
      return ["balance", c, "", "", "", "", o.subtract(i).toFixed()];
    })
    .filter((x): x is string[] => x !== null);
  return {
    id: "vat",
    columns: ["direction", "currency", "code", "treatment", "ratePercent", "taxable", "tax"],
    numeric: ["ratePercent", "taxable", "tax"],
    rows,
    totals,
  };
}

async function margins(db: DbOrTx, companyId: string): Promise<ReportTable> {
  const res = await db.execute<{
    name: string;
    sku: string | null;
    currency: string;
    sale: string | null;
    purchase: string | null;
  }>(sql`
    select name, sku, currency, sale_price::text as sale, purchase_price::text as purchase
    from products where company_id = ${companyId} and archived_at is null order by name limit 2000`);
  const rows = res.rows.map((p) => {
    const sale = p.sale ? new Decimal(p.sale) : null;
    const purchase = p.purchase ? new Decimal(p.purchase) : null;
    const profit = sale && purchase ? sale.minus(purchase) : null;
    return [
      p.name,
      p.sku ?? "",
      p.currency,
      sale?.toFixed(4) ?? "",
      purchase?.toFixed(4) ?? "",
      profit?.toFixed(4) ?? "",
      profit && sale && !sale.isZero()
        ? profit.div(sale).times(100).toDecimalPlaces(2).toFixed(2)
        : "",
      profit && purchase && !purchase.isZero()
        ? profit.div(purchase).times(100).toDecimalPlaces(2).toFixed(2)
        : "",
    ];
  });
  return {
    id: "margins",
    columns: [
      "product",
      "sku",
      "currency",
      "salePrice",
      "purchasePrice",
      "profitPerUnit",
      "marginPercent",
      "markupPercent",
    ],
    numeric: ["salePrice", "purchasePrice", "profitPerUnit", "marginPercent", "markupPercent"],
    rows,
    totals: [],
  };
}

async function stock(db: DbOrTx, companyId: string): Promise<ReportTable> {
  const res = await db.execute<{
    product: string;
    sku: string | null;
    warehouse: string;
    unit: string;
    qty: string;
    currency: string;
    price: string | null;
  }>(sql`
    select p.name as product, p.sku, w.name as warehouse, p.unit, sum(m.quantity)::text as qty, p.currency,
           p.purchase_price::text as price
    from stock_movements m
    join products p on p.id = m.product_id and p.company_id = m.company_id
    join warehouses w on w.id = m.warehouse_id and w.company_id = m.company_id
    where m.company_id = ${companyId}
    group by p.id, w.id order by p.name, w.name`);
  const rows = res.rows.map((x) => {
    const value = x.price ? new Decimal(x.qty).times(x.price) : null;
    return [
      x.product,
      x.sku ?? "",
      x.warehouse,
      new Decimal(x.qty).toFixed(),
      x.unit,
      x.currency,
      x.price ? new Decimal(x.price).toFixed(4) : "",
      value ? m(value.toFixed(), x.currency) : "",
    ];
  });
  return {
    id: "stock",
    columns: [
      "product",
      "sku",
      "warehouse",
      "quantity",
      "unit",
      "currency",
      "purchasePrice",
      "value",
    ],
    numeric: ["quantity", "purchasePrice", "value"],
    rows,
    totals: [],
  };
}

/** Which reports the user may open (the page offers only these). */
export async function availableReports(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<ReportId[]> {
  const ctx = await requireCompanyAccess(db, actor, companyId);
  return REPORTS.filter((id) => {
    const need = PERMISSIONS[id];
    const list = need === undefined ? [] : typeof need === "string" ? [need] : need;
    return list.every((p) => ctx.permissions.has(p));
  });
}

/** One report (its own permissions; forbidden → ForbiddenError like every other read). */
export async function buildReport(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  id: ReportId,
  range: { from: string; to: string },
): Promise<ReportTable> {
  await requireCompanyAccess(db, actor, companyId, PERMISSIONS[id]);
  switch (id) {
    case "pnl":
      return pnl(db, actor, companyId, range);
    case "receivables":
      return receivables(db, actor, companyId);
    case "expenses":
      return expenses(db, companyId, range);
    case "vat":
      return vat(db, companyId, range);
    case "margins":
      return margins(db, companyId);
    case "stock":
      return stock(db, companyId);
  }
}
