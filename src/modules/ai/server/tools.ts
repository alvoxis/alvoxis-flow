import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { z } from "zod";
import { isIsoDate } from "@/modules/finance/domain/receivables";
import { listCalculations } from "@/modules/costing/server/costing-service";
import { businessDashboard } from "@/modules/dashboard/server/business-dashboard";
import { invoiceBalances, todayIso } from "@/modules/finance/server/payment-service";
import { previousRange } from "@/features/dashboard/range";
import { Money } from "@/lib/money";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type DbOrTx } from "@/server/db/client";
import { products } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";

/**
 * The assistant's only access to company data: a fixed set of read-only functions that run with
 * the asking user's own permissions (every one goes through requireCompanyAccess for the company
 * of the request, never another). They return figures already calculated by the application —
 * the model does not do the arithmetic that matters — and label what each figure is. No tool can
 * change data, send anything or run free-form queries. Text that customers or users typed
 * (buyer names, descriptions) is returned as JSON values only, and the system prompt tells the
 * model to treat it as data.
 */

const dateRange = z.strictObject({
  from: z.string().refine(isIsoDate),
  to: z.string().refine(isIsoDate),
});

const rangeSchema = {
  type: "object",
  properties: {
    from: { type: "string", description: "First day, YYYY-MM-DD (inclusive)" },
    to: { type: "string", description: "Last day, YYYY-MM-DD (inclusive)" },
  },
  required: ["from", "to"],
  additionalProperties: false,
} as const;

export const AI_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_period_summary",
    description:
      "Revenue, expenses, gross profit, result, margin and cash flow per currency for a period, with the same figures for the previous period of equal length. Also open receivables and payables today. All figures are calculated from recorded invoices, payments and expenses.",
    input_schema: rangeSchema,
    strict: true,
  },
  {
    name: "list_open_invoices",
    description:
      "Issued invoices that are not fully paid, with open balance, due date and days overdue, largest first (max 25).",
    input_schema: {
      type: "object",
      properties: {
        overdue_only: { type: "boolean", description: "Only invoices past their due date" },
      },
      required: ["overdue_only"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "expected_inflows",
    description:
      "Open invoice balances that fall due within the next N days (and those already overdue), per currency. Based on due dates only; it is not a prediction of when customers will actually pay.",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "Days ahead, 1 to 365" } },
      required: ["days"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "expense_breakdown",
    description:
      "Expenses at cost per category for a period and for the previous period of equal length, with the change, per currency.",
    input_schema: rangeSchema,
    strict: true,
  },
  {
    name: "product_price_margins",
    description:
      "Active products with both a sale and a purchase price in the catalog, with the list-price margin and markup. These are catalogue prices, not realised results, and exclude other costs.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "saved_cost_calculations",
    description:
      "Saved full-cost calculations: unit cost, sale price, margin and markup, and whether a rate still needs verification.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];

export interface ToolContext {
  db: DbOrTx;
  actor: Actor;
  companyId: string;
}

/** part ÷ whole in percent, one decimal (decimal arithmetic); null for a zero whole. */
const pct = (part: string, whole: string) => {
  const w = new Decimal(whole);
  return w.isZero() ? null : new Decimal(part).div(w).times(100).toDecimalPlaces(1).toNumber();
};

async function periodSummary(ctx: ToolContext, input: unknown) {
  const r = dateRange.parse(input);
  if (r.from > r.to) return { error: "from_after_to" };
  const d = await businessDashboard(ctx.db, ctx.actor, ctx.companyId, r);
  return {
    period: d.range,
    previousPeriod: d.previous,
    kind: "recorded figures (verified from records)",
    sectionsAvailable: d.sections,
    current: d.figures,
    previous: d.previousFigures,
    receivablesToday: d.receivables,
    payablesToday: d.payables,
    invoicesIssuedInPeriod: d.invoiceStatus,
    definitions:
      "revenue = net of issued invoices − credit notes; expenses at cost (net + non-recoverable tax); result = revenue − expenses (before income tax, not an accounting net profit); grossProfit = revenue − materials and goods for resale; cash = recorded payments and paid expenses.",
  };
}

async function openInvoices(ctx: ToolContext, input: unknown) {
  const { overdue_only } = z.strictObject({ overdue_only: z.boolean() }).parse(input);
  const rows = (await invoiceBalances(ctx.db, ctx.actor, ctx.companyId))
    .filter(
      (b) =>
        (b.status === "unpaid" || b.status === "partially_paid") && (!overdue_only || b.overdue),
    )
    .sort((a, b) => Number(b.balance) - Number(a.balance))
    .slice(0, 25);
  return {
    asOf: todayIso(),
    kind: "recorded open balances",
    invoices: rows.map((b) => ({
      number: b.number,
      customer: b.buyerName,
      currency: b.currency,
      openBalance: b.balance,
      issueDate: b.issueDate,
      dueDate: b.dueDate,
      daysOverdue: b.daysOverdue,
      status: b.status,
    })),
  };
}

async function expectedInflows(ctx: ToolContext, input: unknown) {
  const { days } = z.strictObject({ days: z.number().int().min(1).max(365) }).parse(input);
  const today = todayIso();
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const open = (await invoiceBalances(ctx.db, ctx.actor, ctx.companyId)).filter(
    (b) => b.status === "unpaid" || b.status === "partially_paid",
  );
  const sum = (rows: typeof open, currency: "EUR" | "PLN") =>
    rows
      .filter((b) => b.currency === currency)
      .reduce((a, b) => a.add(Money.of(b.balance, currency)), Money.zero(currency))
      .toFixed();
  const dueSoon = open.filter(
    (b) => b.dueDate !== null && b.dueDate >= today && b.dueDate <= until,
  );
  const overdue = open.filter((b) => b.overdue);
  const noDue = open.filter((b) => b.dueDate === null);
  return {
    kind: "estimate based on due dates of recorded invoices (not a payment forecast)",
    from: today,
    until,
    perCurrency: (["EUR", "PLN"] as const)
      .map((c) => ({
        currency: c,
        dueInWindow: sum(dueSoon, c),
        dueInWindowCount: dueSoon.filter((b) => b.currency === c).length,
        alreadyOverdue: sum(overdue, c),
        alreadyOverdueCount: overdue.filter((b) => b.currency === c).length,
        withoutDueDate: sum(noDue, c),
      }))
      .filter((r) => r.dueInWindowCount + r.alreadyOverdueCount > 0 || r.withoutDueDate !== "0.00"),
  };
}

async function expenseBreakdown(ctx: ToolContext, input: unknown) {
  const r = dateRange.parse(input);
  if (r.from > r.to) return { error: "from_after_to" };
  await requireCompanyAccess(ctx.db, ctx.actor, ctx.companyId, "finance.view");
  const prev = previousRange(r);
  const cost = sql`case when tax_recoverable then net_amount else net_amount + tax_amount end`;
  const res = await ctx.db.execute<{
    currency: string;
    category: string;
    current: string;
    previous: string;
  }>(sql`
    select currency::text as currency, category,
           coalesce(sum(${cost}) filter (where expense_date between ${r.from}::date and ${r.to}::date), 0)::text as current,
           coalesce(sum(${cost}) filter (where expense_date between ${prev.from}::date and ${prev.to}::date), 0)::text as previous
    from expenses where company_id = ${ctx.companyId}
      and expense_date between ${prev.from}::date and ${r.to}::date
    group by 1, 2 order by 1, 3 desc`);
  return {
    kind: "recorded expenses at cost",
    period: r,
    previousPeriod: prev,
    categories: res.rows.map((x) => {
      const change = Money.of(x.current, x.currency as "EUR").subtract(
        Money.of(x.previous, x.currency as "EUR"),
      );
      return {
        currency: x.currency,
        category: x.category,
        current: Money.of(x.current, x.currency as "EUR").toFixed(),
        previous: Money.of(x.previous, x.currency as "EUR").toFixed(),
        change: change.toFixed(),
        changePercent: pct(change.toFixed(), x.previous),
      };
    }),
  };
}

async function productMargins(ctx: ToolContext) {
  await requireCompanyAccess(ctx.db, ctx.actor, ctx.companyId, "products.view");
  const rows = await ctx.db
    .select({
      name: products.name,
      sku: products.sku,
      currency: products.currency,
      sale: products.salePrice,
      purchase: products.purchasePrice,
    })
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), isNull(products.archivedAt)))
    .limit(500);
  return {
    kind: "catalogue list prices (not realised results; other costs not included)",
    products: rows
      .filter((p) => p.sale !== null && p.purchase !== null && Number(p.sale) > 0)
      .map((p) => {
        const profit = new Decimal(p.sale!).minus(p.purchase!).toFixed(4);
        return {
          name: p.name,
          sku: p.sku,
          currency: p.currency,
          salePrice: p.sale,
          purchasePrice: p.purchase,
          marginPercent: pct(profit, p.sale!),
          markupPercent: pct(profit, p.purchase!),
        };
      })
      .sort((a, b) => (b.marginPercent ?? 0) - (a.marginPercent ?? 0))
      .slice(0, 50),
  };
}

async function savedCalculations(ctx: ToolContext) {
  const list = await listCalculations(ctx.db, ctx.actor, ctx.companyId);
  return {
    kind: "saved cost calculations (figures computed by the application)",
    calculations: list.slice(0, 30).map((c) => ({
      name: c.name,
      product: c.productName,
      currency: c.currency,
      quantity: c.result.quantity,
      totalCost: c.result.totalCost,
      unitCost: c.result.unitCost,
      salePrice: c.result.pricing?.salePrice ?? null,
      marginPercent: c.result.pricing?.marginPercent ?? null,
      markupPercent: c.result.pricing?.markupPercent ?? null,
      ratesNeedVerification: c.result.warnings.length > 0,
    })),
  };
}

/**
 * Runs one tool call for the asking user. Unknown tools, bad input and missing permissions come
 * back as an error object (the model is told so and must say it lacks the data), never thrown.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  input: unknown,
): Promise<{ result: unknown; isError: boolean }> {
  try {
    switch (name) {
      case "get_period_summary":
        return { result: await periodSummary(ctx, input), isError: false };
      case "list_open_invoices":
        return { result: await openInvoices(ctx, input), isError: false };
      case "expected_inflows":
        return { result: await expectedInflows(ctx, input), isError: false };
      case "expense_breakdown":
        return { result: await expenseBreakdown(ctx, input), isError: false };
      case "product_price_margins":
        return { result: await productMargins(ctx), isError: false };
      case "saved_cost_calculations":
        return { result: await savedCalculations(ctx), isError: false };
      default:
        return { result: { error: "unknown_tool" }, isError: true };
    }
  } catch (err) {
    if (err instanceof ForbiddenError)
      return { result: { error: "not_permitted_for_this_user" }, isError: true };
    if (err instanceof z.ZodError) return { result: { error: "invalid_input" }, isError: true };
    throw err;
  }
}
