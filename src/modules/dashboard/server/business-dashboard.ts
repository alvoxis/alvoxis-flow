import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { bucketKeys, bucketOf, previousRange } from "@/features/dashboard/range";
import { type CurrencyCode, isCurrencyCode, Money, SUPPORTED_CURRENCIES } from "@/lib/money";
import { invoiceBalancesUnchecked, todayIso } from "@/modules/finance/server/payment-service";
import { type Actor, hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type DbOrTx } from "@/server/db/client";

/**
 * The business dashboard of one company for a period (inclusive dates). Every figure comes from
 * recorded data, per currency (EUR and PLN are never added together), with these definitions:
 *
 * - Revenue: net totals (excl. tax) of issued invoices and credit notes dated in the period.
 * - Direct costs: expenses in the categories "materials" and "goods for resale".
 * - Expenses: all recorded expenses dated in the period, at cost (net + non-recoverable tax).
 * - Gross profit: revenue − direct costs.
 * - Result: revenue − all expenses (before income tax; not an accounting net profit, which also
 *   needs depreciation, accruals and taxes that this application does not record).
 * - Margin: result ÷ revenue.
 * - Cash in / out: payments received on invoices / paid expenses (gross), by payment date.
 * - Receivables / payables: open balances today (all periods), overdue = past the due date.
 *
 * Sections are shown only with their permissions: sales (analytics.view + documents.view),
 * finance (analytics.view + finance.view), stock (inventory.view), activity (audit.view).
 */

export interface PeriodFigures {
  currency: CurrencyCode;
  revenue: string;
  directCosts: string;
  expenses: string;
  grossProfit: string;
  result: string;
  /** Percent with one decimal; null without revenue. */
  marginPercent: string | null;
  cashIn: string;
  cashOut: string;
  netCash: string;
}

export interface SeriesPoint {
  key: string;
  revenue: string;
  expenses: string;
  cashIn: string;
  cashOut: string;
}

export interface OpenItems {
  currency: CurrencyCode;
  open: string;
  openCount: number;
  overdue: string;
  overdueCount: number;
}

export interface ActivityItem {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  at: string;
  actor: string | null;
}

export interface BusinessDashboard {
  range: { from: string; to: string };
  previous: { from: string; to: string };
  bucket: "day" | "month";
  sections: { sales: boolean; finance: boolean; stock: boolean; activity: boolean };
  /** Currencies with any figure in either period (EUR first). */
  currencies: CurrencyCode[];
  figures: PeriodFigures[];
  previousFigures: PeriodFigures[];
  series: Record<string, SeriesPoint[]>;
  receivables: OpenItems[] | null;
  payables: OpenItems[] | null;
  invoiceStatus: {
    paid: number;
    partiallyPaid: number;
    unpaid: number;
    credited: number;
    overdue: number;
  } | null;
  expenseCategories: { currency: CurrencyCode; category: string; cost: string }[] | null;
  stock: { currency: string; value: string }[] | null;
  activity: ActivityItem[] | null;
  permissions: {
    createDocuments: boolean;
    manageProducts: boolean;
    manageFinance: boolean;
    manageCustomers: boolean;
    useAi: boolean;
    viewReports: boolean;
  };
}

type Sums = Map<
  string,
  { revenue: Money; direct: Money; expenses: Money; cashIn: Money; cashOut: Money }
>;

const DIRECT = sql`('materials', 'goods_for_resale')`;

/** Sums per (bucket key, currency); `fmt` null sums the whole period per currency. */
async function periodSums(
  db: DbOrTx,
  companyId: string,
  r: { from: string; to: string },
  fmt: "YYYY-MM-DD" | "YYYY-MM" | null,
  include: { sales: boolean; finance: boolean },
): Promise<Sums> {
  const key = (col: ReturnType<typeof sql.raw>) =>
    fmt ? sql`to_char(${col}, ${fmt})` : sql`'all'`;
  const out: Sums = new Map();
  const slot = (k: string, c: CurrencyCode) => {
    const id = `${k}|${c}`;
    let s = out.get(id);
    if (!s) {
      const z = Money.zero(c);
      s = { revenue: z, direct: z, expenses: z, cashIn: z, cashOut: z };
      out.set(id, s);
    }
    return s;
  };
  const queries: Promise<void>[] = [];
  if (include.sales) {
    queries.push(
      db
        .execute<{ k: string; currency: string; net: string }>(
          sql`
          select ${key(sql.raw("d.issue_date"))} as k, d.currency::text as currency,
                 coalesce(sum(d.net_total), 0)::text as net
          from documents d
          where d.company_id = ${companyId} and d.status = 'issued'
            and d.type in ('invoice', 'credit_note')
            and d.issue_date between ${r.from}::date and ${r.to}::date
          group by 1, 2`,
        )
        .then((res) => {
          for (const row of res.rows)
            if (isCurrencyCode(row.currency))
              slot(row.k, row.currency).revenue = Money.of(row.net, row.currency);
        }),
    );
  }
  if (include.finance) {
    queries.push(
      db
        .execute<{ k: string; currency: string; cost: string; direct: string }>(
          sql`
          select ${key(sql.raw("e.expense_date"))} as k, e.currency::text as currency,
                 coalesce(sum(case when e.tax_recoverable then e.net_amount
                                   else e.net_amount + e.tax_amount end), 0)::text as cost,
                 coalesce(sum(case when e.category in ${DIRECT} then
                                (case when e.tax_recoverable then e.net_amount
                                      else e.net_amount + e.tax_amount end) end), 0)::text as direct
          from expenses e
          where e.company_id = ${companyId}
            and e.expense_date between ${r.from}::date and ${r.to}::date
          group by 1, 2`,
        )
        .then((res) => {
          for (const row of res.rows)
            if (isCurrencyCode(row.currency)) {
              const s = slot(row.k, row.currency);
              s.expenses = Money.of(row.cost, row.currency);
              s.direct = Money.of(row.direct, row.currency);
            }
        }),
      db
        .execute<{ k: string; currency: string; total: string }>(
          sql`
          select ${key(sql.raw("e.paid_on"))} as k, e.currency::text as currency,
                 coalesce(sum(e.net_amount + e.tax_amount), 0)::text as total
          from expenses e
          where e.company_id = ${companyId} and e.status = 'paid'
            and e.paid_on between ${r.from}::date and ${r.to}::date
          group by 1, 2`,
        )
        .then((res) => {
          for (const row of res.rows)
            if (isCurrencyCode(row.currency))
              slot(row.k, row.currency).cashOut = Money.of(row.total, row.currency);
        }),
    );
    if (include.sales)
      queries.push(
        db
          .execute<{ k: string; currency: string; total: string }>(
            sql`
            select ${key(sql.raw("p.paid_on"))} as k, p.currency::text as currency,
                   coalesce(sum(p.amount), 0)::text as total
            from document_payments p
            where p.company_id = ${companyId} and p.voided_at is null
              and p.paid_on between ${r.from}::date and ${r.to}::date
            group by 1, 2`,
          )
          .then((res) => {
            for (const row of res.rows)
              if (isCurrencyCode(row.currency))
                slot(row.k, row.currency).cashIn = Money.of(row.total, row.currency);
          }),
      );
  }
  await Promise.all(queries);
  return out;
}

function figuresOf(sums: Sums, currency: CurrencyCode): PeriodFigures {
  const z = Money.zero(currency);
  let revenue = z,
    direct = z,
    expenses = z,
    cashIn = z,
    cashOut = z;
  for (const [id, s] of sums) {
    if (!id.endsWith(`|${currency}`)) continue;
    revenue = revenue.add(s.revenue);
    direct = direct.add(s.direct);
    expenses = expenses.add(s.expenses);
    cashIn = cashIn.add(s.cashIn);
    cashOut = cashOut.add(s.cashOut);
  }
  const result = revenue.subtract(expenses);
  const margin = revenue.isZero()
    ? null
    : new Decimal(result.toDecimalString())
        .div(revenue.toDecimalString())
        .times(100)
        .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
        .toFixed(1);
  return {
    currency,
    revenue: revenue.toFixed(),
    directCosts: direct.toFixed(),
    expenses: expenses.toFixed(),
    grossProfit: revenue.subtract(direct).toFixed(),
    result: result.toFixed(),
    marginPercent: margin,
    cashIn: cashIn.toFixed(),
    cashOut: cashOut.toFixed(),
    netCash: cashIn.subtract(cashOut).toFixed(),
  };
}

const hasAny = (f: PeriodFigures) =>
  [f.revenue, f.expenses, f.cashIn, f.cashOut].some((v) => !Money.of(v, f.currency).isZero());

/** The dashboard of `companyId` for `range` (any member; sections by permission). */
export async function businessDashboard(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  range: { from: string; to: string },
): Promise<BusinessDashboard> {
  const ctx = await requireCompanyAccess(db, actor, companyId);
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(ctx, p);
  const sections = {
    sales: can("analytics.view") && can("documents.view"),
    finance: can("analytics.view") && can("finance.view"),
    stock: can("inventory.view"),
    activity: can("audit.view"),
  };
  const bucket = bucketOf(range);
  const prev = previousRange(range);
  const [current, previous] = await Promise.all([
    periodSums(db, companyId, range, bucket === "day" ? "YYYY-MM-DD" : "YYYY-MM", sections),
    periodSums(db, companyId, prev, null, sections),
  ]);

  const figuresAll = SUPPORTED_CURRENCIES.map((c) => figuresOf(current, c));
  const previousAll = SUPPORTED_CURRENCIES.map((c) => figuresOf(previous, c));
  const currencies = SUPPORTED_CURRENCIES.filter(
    (_c, i) => hasAny(figuresAll[i]!) || hasAny(previousAll[i]!),
  );
  const keys = bucketKeys(range);
  const series: Record<string, SeriesPoint[]> = {};
  for (const c of currencies)
    series[c] = keys.map((k) => {
      const s = current.get(`${k}|${c}`);
      const z = Money.zero(c).toFixed();
      return {
        key: k,
        revenue: s?.revenue.toFixed() ?? z,
        expenses: s?.expenses.toFixed() ?? z,
        cashIn: s?.cashIn.toFixed() ?? z,
        cashOut: s?.cashOut.toFixed() ?? z,
      };
    });

  const today = todayIso();
  let receivables: BusinessDashboard["receivables"] = null;
  let invoiceStatus: BusinessDashboard["invoiceStatus"] = null;
  if (sections.sales && can("finance.view")) {
    const balances = await invoiceBalancesUnchecked(db, companyId, { asOf: today });
    receivables = SUPPORTED_CURRENCIES.map((c) => {
      const open = balances.filter(
        (b) => b.currency === c && (b.status === "unpaid" || b.status === "partially_paid"),
      );
      const overdue = open.filter((b) => b.overdue);
      const sum = (rows: typeof open) =>
        rows.reduce((acc, b) => acc.add(Money.of(b.balance, c)), Money.zero(c)).toFixed();
      return {
        currency: c,
        open: sum(open),
        openCount: open.length,
        overdue: sum(overdue),
        overdueCount: overdue.length,
      };
    }).filter((r) => r.openCount > 0);
    const inRange = balances.filter((b) => b.issueDate >= range.from && b.issueDate <= range.to);
    invoiceStatus = {
      paid: inRange.filter((b) => b.status === "paid").length,
      partiallyPaid: inRange.filter((b) => b.status === "partially_paid").length,
      unpaid: inRange.filter((b) => b.status === "unpaid").length,
      credited: inRange.filter((b) => b.status === "credited").length,
      overdue: inRange.filter((b) => b.overdue).length,
    };
  }

  let payables: BusinessDashboard["payables"] = null;
  let expenseCategories: BusinessDashboard["expenseCategories"] = null;
  if (sections.finance) {
    const [open, cats] = await Promise.all([
      db.execute<{
        currency: string;
        open: string;
        open_count: number;
        overdue: string;
        overdue_count: number;
      }>(sql`
        select currency::text as currency,
               coalesce(sum(net_amount + tax_amount), 0)::text as open, count(*)::int as open_count,
               coalesce(sum(net_amount + tax_amount) filter (where due_date < ${today}::date), 0)::text as overdue,
               count(*) filter (where due_date < ${today}::date)::int as overdue_count
        from expenses where company_id = ${companyId} and status = 'unpaid'
        group by 1 order by 1`),
      db.execute<{ currency: string; category: string; cost: string }>(sql`
        select currency::text as currency, category,
               sum(case when tax_recoverable then net_amount else net_amount + tax_amount end)::text as cost
        from expenses
        where company_id = ${companyId} and expense_date between ${range.from}::date and ${range.to}::date
        group by 1, 2 order by 1, sum(case when tax_recoverable then net_amount else net_amount + tax_amount end) desc`),
    ]);
    payables = open.rows
      .filter((r) => isCurrencyCode(r.currency))
      .map((r) => ({
        currency: r.currency as CurrencyCode,
        open: Money.of(r.open, r.currency as CurrencyCode).toFixed(),
        openCount: r.open_count,
        overdue: Money.of(r.overdue, r.currency as CurrencyCode).toFixed(),
        overdueCount: r.overdue_count,
      }));
    expenseCategories = cats.rows
      .filter((r) => isCurrencyCode(r.currency))
      .map((r) => ({
        currency: r.currency as CurrencyCode,
        category: r.category,
        cost: Money.of(r.cost, r.currency as CurrencyCode).toFixed(),
      }));
  }

  let stock: BusinessDashboard["stock"] = null;
  if (sections.stock) {
    const rows = await db.execute<{ currency: string; value: string }>(sql`
      select p.currency, round(sum(b.quantity * p.purchase_price), 2)::text as value
      from (select product_id, sum(quantity) as quantity from stock_movements
            where company_id = ${companyId} group by product_id) b
      join products p on p.id = b.product_id and p.company_id = ${companyId}
      where p.purchase_price is not null
      group by p.currency order by p.currency`);
    stock = rows.rows.map((r) => ({ currency: r.currency, value: r.value }));
  }

  let activity: BusinessDashboard["activity"] = null;
  if (sections.activity) {
    const rows = await db.execute<{
      id: string;
      action: string;
      entity_type: string | null;
      entity_id: string | null;
      created_at: Date;
      actor: string | null;
    }>(sql`
      select a.id, a.action, a.entity_type, a.entity_id, a.created_at,
             coalesce(u.display_name, u.email) as actor
      from audit_logs a left join users u on u.id = a.actor_user_id
      where a.company_id = ${companyId}
      order by a.created_at desc limit 12`);
    activity = rows.rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      at: new Date(r.created_at).toISOString(),
      actor: r.actor,
    }));
  }

  return {
    range,
    previous: prev,
    bucket,
    sections,
    currencies,
    figures: figuresAll.filter((f) => currencies.includes(f.currency)),
    previousFigures: previousAll.filter((f) => currencies.includes(f.currency)),
    series,
    receivables,
    payables,
    invoiceStatus,
    expenseCategories,
    stock,
    activity,
    permissions: {
      createDocuments: can("documents.create"),
      manageProducts: can("products.manage"),
      manageFinance: can("finance.manage"),
      manageCustomers: can("customers.manage"),
      useAi: can("ai.use"),
      viewReports: can("analytics.view"),
    },
  };
}
