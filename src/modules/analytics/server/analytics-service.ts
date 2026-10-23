import "server-only";
import { sql } from "drizzle-orm";
import { hasPermission, type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type DbOrTx } from "@/server/db/client";

/**
 * Read-only figures for one calendar year (analytics.view and documents.view). Sales are issued
 * invoices plus issued credit notes (negative), net of tax, per currency — never converted or
 * mixed. Optional sections appear only with their own permission: stock value (inventory.view)
 * and payroll cost of approved months (payroll.view). All sums run in PostgreSQL numeric.
 */

export interface MonthSales {
  /** 1–12 */
  month: number;
  currency: string;
  net: string;
  invoices: number;
  creditNotes: number;
}

export interface CustomerSales {
  name: string;
  registrationNumber: string | null;
  currency: string;
  net: string;
  documents: number;
}

export interface ItemSales {
  description: string;
  unit: string | null;
  currency: string;
  quantity: string;
  net: string;
}

export interface AnalyticsView {
  year: number;
  /** Years that have issued documents, newest first (always includes `year`). */
  years: number[];
  months: MonthSales[];
  customers: CustomerSales[];
  items: ItemSales[];
  /** Value of stock at purchase price per currency; null without inventory.view. */
  stock: { currency: string; value: string }[] | null;
  /** Employer cost of approved payroll months of the year; null without payroll.view. */
  payroll: { currency: string; employerCost: string; months: number }[] | null;
  production: { completed: number; planned: number } | null;
}

const money = (v: string | null) => {
  const [i = "0", f = ""] = (v ?? "0").split(".");
  return `${i}.${(f + "00").slice(0, 2)}`;
};
const qty = (v: string) => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

/** Figures of `year` for the company. */
export async function companyAnalytics(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  year: number,
): Promise<AnalyticsView> {
  const ctx = await requireCompanyAccess(db, actor, companyId, [
    "analytics.view",
    "documents.view",
  ]);
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const issued = sql`d.company_id = ${companyId} and d.status = 'issued'
    and d.type in ('invoice', 'credit_note')
    and d.issue_date >= ${from}::date and d.issue_date < ${to}::date`;

  const [months, customers, items, years] = await Promise.all([
    db.execute<{
      month: number;
      currency: string;
      net: string;
      invoices: number;
      creditNotes: number;
    }>(sql`
      select extract(month from d.issue_date)::int as month, d.currency::text as currency,
             sum(d.net_total)::text as net,
             count(*) filter (where d.type = 'invoice')::int as invoices,
             count(*) filter (where d.type = 'credit_note')::int as "creditNotes"
      from documents d where ${issued}
      group by 1, 2 order by 2, 1`),
    db.execute<{
      name: string;
      registrationNumber: string | null;
      currency: string;
      net: string;
      documents: number;
    }>(sql`
      select d.buyer->>'name' as name, nullif(d.buyer->>'registrationNumber', '') as "registrationNumber",
             d.currency::text as currency, sum(d.net_total)::text as net, count(*)::int as documents
      from documents d where ${issued}
      group by 1, 2, 3 order by sum(d.net_total) desc, 1 limit 10`),
    db.execute<{
      description: string;
      unit: string | null;
      currency: string;
      quantity: string;
      net: string;
    }>(sql`
      select l.description, l.unit, d.currency::text as currency,
             sum(l.quantity)::text as quantity, sum(l.net_amount)::text as net
      from document_lines l join documents d on d.id = l.document_id and d.company_id = l.company_id
      where ${issued} and l.net_amount is not null
      group by 1, 2, 3 order by sum(l.net_amount) desc, 1 limit 10`),
    db.execute<{ year: number }>(sql`
      select distinct extract(year from issue_date)::int as year from documents
      where company_id = ${companyId} and status = 'issued' order by 1 desc`),
  ]);

  let stock: AnalyticsView["stock"] = null;
  if (hasPermission(ctx, "inventory.view")) {
    const rows = await db.execute<{ currency: string; value: string }>(sql`
      select p.currency, round(sum(b.quantity * p.purchase_price), 2)::text as value
      from (select product_id, sum(quantity) as quantity from stock_movements
            where company_id = ${companyId} group by product_id) b
      join products p on p.id = b.product_id and p.company_id = ${companyId}
      where p.purchase_price is not null
      group by p.currency order by p.currency`);
    stock = rows.rows.map((r) => ({ currency: r.currency, value: money(r.value) }));
  }

  let payroll: AnalyticsView["payroll"] = null;
  if (hasPermission(ctx, "payroll.view")) {
    const rows = await db.execute<{ currency: string; employerCost: string; months: number }>(sql`
      select l.currency, sum(l.employer_cost)::text as "employerCost", count(distinct r.id)::int as months
      from payroll_lines l join payroll_runs r on r.id = l.run_id and r.company_id = l.company_id
      where r.company_id = ${companyId} and r.status = 'approved' and r.period like ${`${year}-%`}
      group by l.currency order by l.currency`);
    payroll = rows.rows.map((r) => ({ ...r, employerCost: money(r.employerCost) }));
  }

  let production: AnalyticsView["production"] = null;
  if (hasPermission(ctx, "production.view")) {
    const [row] = (
      await db.execute<{ completed: number; planned: number }>(sql`
        select count(*) filter (where status = 'completed' and completed_on >= ${from}::date
                                  and completed_on < ${to}::date)::int as completed,
               count(*) filter (where status = 'planned')::int as planned
        from production_orders where company_id = ${companyId}`)
    ).rows;
    production = row ?? { completed: 0, planned: 0 };
  }

  return {
    year,
    years: [...new Set([year, ...years.rows.map((r) => r.year)])].sort((a, b) => b - a),
    months: months.rows.map((r) => ({ ...r, net: money(r.net) })),
    customers: customers.rows.map((r) => ({ ...r, net: money(r.net) })),
    items: items.rows.map((r) => ({ ...r, quantity: qty(r.quantity), net: money(r.net) })),
    stock,
    payroll,
    production,
  };
}
