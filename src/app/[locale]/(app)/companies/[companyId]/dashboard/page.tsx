import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { type ReactNode } from "react";
import { BarPairChart, CategoryBars, LineChart } from "@/components/dashboard/business/charts";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/form";
import { percentChange } from "@/features/dashboard/compare";
import { parseRange, RANGE_PRESETS } from "@/features/dashboard/range";
import { type AppLocale, LOCALE_FORMAT_TAGS } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { formatDate, formatMoney } from "@/lib/format";
import { type CurrencyCode } from "@/lib/money";
import { requirePageUser } from "@/server/auth/page-session";
import { businessDashboardPageData } from "@/server/dashboard/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };
type Props = Params & { searchParams: Promise<{ range?: string; from?: string; to?: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "business" });
  return { title: t("title") };
}

const KPIS = ["revenue", "expenses", "result", "grossProfit", "cashIn", "netCash"] as const;
type Kpi = (typeof KPIS)[number];
/** Figures where a rise is good (expenses and cash out are the opposite). */
const RISE_IS_GOOD: Record<Kpi, boolean> = {
  revenue: true,
  expenses: false,
  result: true,
  grossProfit: true,
  cashIn: true,
  netCash: true,
};

/**
 * Business dashboard of one company for a period: KPIs per currency from recorded data, the
 * change against the previous period, charts, open receivables and payables, stock value,
 * recent activity and quick actions. Every figure has a definition at the bottom; sections the
 * role may not see are left out.
 */
export default async function BusinessDashboardPage({ params, searchParams }: Props) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const today = new Date().toISOString().slice(0, 10);
  const range = parseRange(await searchParams, today);
  const data = await businessDashboardPageData(user, companyId, range);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("business");
  const tCompany = await getTranslations("company");
  const tFin = await getTranslations("finance");
  if (data.status === "two_factor_required")
    return (
      <Alert tone="warning">
        {tCompany("twoFactorRequired")}{" "}
        <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
      </Alert>
    );

  const d = data.dashboard;
  const loc = locale as AppLocale;
  const tag = LOCALE_FORMAT_TAGS[loc];
  const base = `/companies/${companyId}`;
  const money = (v: string, c: CurrencyCode) => formatMoney(v, c, loc);
  const bucketLabel = (key: string) =>
    d.bucket === "day"
      ? new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", timeZone: "UTC" }).format(
          new Date(`${key}T00:00:00Z`),
        )
      : new Intl.DateTimeFormat(tag, { month: "short", year: "2-digit", timeZone: "UTC" }).format(
          new Date(`${key}-01T00:00:00Z`),
        );
  const showMoney = d.sections.sales || d.sections.finance;
  const noData =
    d.currencies.length === 0 && !d.receivables?.length && !d.payables?.length && !d.stock?.length;

  const kpiVisible = (k: Kpi) =>
    k === "revenue"
      ? d.sections.sales
      : k === "cashIn"
        ? d.sections.sales && d.sections.finance
        : k === "expenses"
          ? d.sections.finance
          : d.sections.sales && d.sections.finance;

  return (
    <div className="space-y-8" data-testid="business-dashboard">
      <header className="relative isolate space-y-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-10 -z-10 h-40 overflow-hidden"
        >
          <div className="mx-auto h-full max-w-2xl bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-accent-strong)_24%,transparent),transparent)]" />
        </div>
        <div>
          <p className="text-sm text-muted">{data.companyName}</p>
          <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted" data-testid="dashboard-period">
            {t("period", { from: formatDate(d.range.from, loc), to: formatDate(d.range.to, loc) })}
          </p>
        </div>
        {/* Filters: one row above everything they scope. */}
        <nav
          aria-label={t("rangeLabel")}
          className="flex flex-wrap items-end gap-2"
          data-testid="range-picker"
        >
          {RANGE_PRESETS.filter((p) => p !== "custom").map((p) => (
            <Link
              key={p}
              href={`${base}/dashboard?range=${p}`}
              aria-current={range.preset === p ? "page" : undefined}
              className={`inline-flex min-h-10 items-center rounded-full border px-3.5 text-sm transition-colors ${
                range.preset === p
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border text-muted hover:border-accent/60 hover:text-text"
              }`}
            >
              {t(`range.${p}`)}
            </Link>
          ))}
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="range" value="custom" />
            <label className="text-xs text-muted">
              {t("range.from")}
              <input
                type="date"
                name="from"
                defaultValue={d.range.from}
                required
                className="mt-1 block rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm text-text"
              />
            </label>
            <label className="text-xs text-muted">
              {t("range.to")}
              <input
                type="date"
                name="to"
                defaultValue={d.range.to}
                required
                className="mt-1 block rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm text-text"
              />
            </label>
            <button
              type="submit"
              className="min-h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text hover:border-accent/60"
            >
              {t("range.apply")}
            </button>
          </form>
        </nav>
      </header>

      <QuickActions t={t} base={base} p={d.permissions} sections={d.sections} />

      {noData ? (
        <div
          className="animate-fade-up rounded-2xl border border-dashed border-border p-8 text-center"
          data-testid="dashboard-empty"
        >
          <p className="font-medium text-text">{t("empty.title")}</p>
          <p className="mx-auto mt-1 max-w-prose text-sm text-muted">
            {showMoney ? t("empty.text") : t("empty.noFinance")}
          </p>
        </div>
      ) : null}

      {d.figures.map((f) => {
        const prev = d.previousFigures.find((p) => p.currency === f.currency)!;
        return (
          <section key={f.currency} aria-labelledby={`kpi-${f.currency}`} className="space-y-3">
            <h2
              id={`kpi-${f.currency}`}
              className="text-xs font-semibold tracking-wider text-muted uppercase"
            >
              {t("figuresIn", { currency: f.currency })}
            </h2>
            <ul
              className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
              data-testid={`kpis-${f.currency}`}
            >
              {KPIS.filter(kpiVisible).map((k, i) => (
                <KpiCard
                  key={k}
                  index={i}
                  label={t(`kpi.${k}`)}
                  value={f[k]}
                  currency={f.currency}
                  locale={loc}
                  change={percentChange(f[k], prev[k])}
                  riseIsGood={RISE_IS_GOOD[k]}
                  t={t}
                  note={
                    k === "result" && f.marginPercent !== null
                      ? t("margin", { percent: f.marginPercent })
                      : null
                  }
                  testId={`kpi-${k}`}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {(d.receivables || d.payables || d.invoiceStatus || d.stock) && !noData ? (
        <section aria-labelledby="open-items" className="space-y-3">
          <h2 id="open-items" className="text-xs font-semibold tracking-wider text-muted uppercase">
            {t("openItems")}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {d.receivables?.map((r) => (
              <Tile key={`r-${r.currency}`} label={t("receivables")} testId="tile-receivables">
                <p className="text-2xl font-semibold text-text tabular-nums">
                  {money(r.open, r.currency)}
                </p>
                <p className="text-xs text-muted">{t("invoicesOpen", { count: r.openCount })}</p>
                {r.overdueCount > 0 ? (
                  <Link
                    href={`${base}/reports?view=receivables`}
                    className="mt-2 inline-flex items-center gap-1.5 text-sm text-danger hover:underline"
                    data-testid="overdue-link"
                  >
                    <span aria-hidden="true">●</span>
                    {t("overdue", { count: r.overdueCount, amount: money(r.overdue, r.currency) })}
                  </Link>
                ) : (
                  <p className="mt-2 text-sm text-success">{t("noOverdue")}</p>
                )}
              </Tile>
            ))}
            {d.payables?.map((p) => (
              <Tile key={`p-${p.currency}`} label={t("payables")} testId="tile-payables">
                <p className="text-2xl font-semibold text-text tabular-nums">
                  {money(p.open, p.currency)}
                </p>
                <p className="text-xs text-muted">{t("expensesUnpaid", { count: p.openCount })}</p>
                {p.overdueCount > 0 ? (
                  <Link
                    href={`${base}/finance?status=unpaid`}
                    className="mt-2 inline-flex items-center gap-1.5 text-sm text-danger hover:underline"
                  >
                    <span aria-hidden="true">●</span>
                    {t("payablesOverdue", {
                      count: p.overdueCount,
                      amount: money(p.overdue, p.currency),
                    })}
                  </Link>
                ) : null}
              </Tile>
            ))}
            {d.invoiceStatus ? (
              <Tile label={t("invoiceStatus.title")} testId="tile-invoice-status">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  {(["paid", "partiallyPaid", "unpaid", "overdue"] as const).map((s) => (
                    <div key={s} className="contents">
                      <dt className="text-muted">{t(`invoiceStatus.${s}`)}</dt>
                      <dd
                        className="text-right font-medium text-text tabular-nums"
                        data-testid={`status-${s}`}
                      >
                        {d.invoiceStatus![s]}
                      </dd>
                    </div>
                  ))}
                </dl>
                <Link
                  href={`${base}/documents?type=invoice`}
                  className="mt-2 inline-block text-xs text-accent hover:underline"
                >
                  {t("toInvoices")}
                </Link>
              </Tile>
            ) : null}
            {d.stock?.map((s) => (
              <Tile key={`s-${s.currency}`} label={t("stockValue")} testId="tile-stock">
                <p className="text-2xl font-semibold text-text tabular-nums">
                  {money(s.value, s.currency as CurrencyCode)}
                </p>
                <p className="text-xs text-muted">{t("stockValueNote")}</p>
              </Tile>
            ))}
          </ul>
        </section>
      ) : null}

      {d.currencies.map((c) => {
        const series = d.series[c] ?? [];
        let running = 0;
        const cats = (d.expenseCategories ?? []).filter((e) => e.currency === c).slice(0, 6);
        return (
          <section
            key={`charts-${c}`}
            aria-label={t("chartsIn", { currency: c })}
            className="grid gap-4 lg:grid-cols-2"
          >
            {d.sections.sales || d.sections.finance ? (
              <div className="animate-fade-up rounded-2xl p-4 surface-raised lg:col-span-2">
                <BarPairChart
                  title={t("chart.revenueVsExpenses", { currency: c })}
                  aLabel={t("kpi.revenue")}
                  bLabel={t("kpi.expenses")}
                  axisFormat={{ locale: tag, currency: c }}
                  tableLabel={t("chart.table")}
                  bucketLabel={t(d.bucket === "day" ? "chart.day" : "chart.month")}
                  points={series.map((p) => ({
                    label: bucketLabel(p.key),
                    a: Number(p.revenue),
                    b: Number(p.expenses),
                    aText: money(p.revenue, c),
                    bText: money(p.expenses, c),
                  }))}
                />
              </div>
            ) : null}
            {d.sections.finance && d.sections.sales ? (
              <div className="animate-fade-up rounded-2xl p-4 surface-raised">
                <LineChart
                  title={t("chart.cash", { currency: c })}
                  seriesLabel={t("chart.cashSeries")}
                  axisFormat={{ locale: tag, currency: c }}
                  tableLabel={t("chart.table")}
                  bucketLabel={t(d.bucket === "day" ? "chart.day" : "chart.month")}
                  points={series.map((p) => {
                    running += Number(p.cashIn) - Number(p.cashOut);
                    const v = running.toFixed(2);
                    return { label: bucketLabel(p.key), value: running, text: money(v, c) };
                  })}
                />
              </div>
            ) : null}
            {d.sections.finance ? (
              <div className="animate-fade-up rounded-2xl p-4 surface-raised">
                {cats.length ? (
                  <CategoryBars
                    title={t("chart.categories", { currency: c })}
                    items={cats.map((e) => ({
                      label: tFin(`category.${e.category}` as Parameters<typeof tFin>[0]),
                      value: Number(e.cost),
                      text: money(e.cost, c),
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted">{t("noExpenses")}</p>
                )}
              </div>
            ) : null}
          </section>
        );
      })}

      {d.activity ? (
        <section aria-labelledby="activity" className="space-y-3">
          <h2 id="activity" className="text-xs font-semibold tracking-wider text-muted uppercase">
            {t("activity.title")}
          </h2>
          {d.activity.length === 0 ? (
            <p className="text-sm text-muted">{t("activity.none")}</p>
          ) : (
            <ol
              className="divide-y divide-border rounded-2xl border border-border"
              data-testid="activity-list"
            >
              {d.activity.map((a, i) => {
                const key = `activity.actions.${a.action}` as Parameters<typeof t>[0];
                return (
                  <li
                    key={a.id}
                    className="flex animate-fade-up flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm"
                    style={{ animationDelay: `${i * 25}ms` }}
                  >
                    <span className="text-text">{t.has(key) ? t(key) : t("activity.other")}</span>
                    {a.actor ? <span className="text-xs text-muted">{a.actor}</span> : null}
                    <time dateTime={a.at} className="ml-auto text-xs text-muted tabular-nums">
                      {new Intl.DateTimeFormat(tag, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(a.at))}
                    </time>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : null}

      {showMoney ? (
        <details className="rounded-2xl border border-border p-4 text-sm" data-testid="definitions">
          <summary className="cursor-pointer font-medium text-text">
            {t("definitions.title")}
          </summary>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {(
              [
                "revenue",
                "expenses",
                "grossProfit",
                "result",
                "cash",
                "receivables",
                "payables",
                "previous",
              ] as const
            ).map((k) => (
              <div key={k}>
                <dt className="font-medium text-text">{t(`definitions.${k}.term`)}</dt>
                <dd className="text-muted">{t(`definitions.${k}.text`)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">{t("definitions.note")}</p>
        </details>
      ) : null}
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"business">>>;

function KpiCard({
  label,
  value,
  currency,
  locale,
  change,
  riseIsGood,
  note,
  t,
  index,
  testId,
}: {
  label: string;
  value: string;
  currency: CurrencyCode;
  locale: AppLocale;
  change: string | null;
  riseIsGood: boolean;
  note: string | null;
  t: T;
  index: number;
  testId: string;
}) {
  const up = change !== null && change.startsWith("+");
  const down = change !== null && change.startsWith("-");
  const good = (up && riseIsGood) || (down && !riseIsGood);
  const bad = (down && riseIsGood) || (up && !riseIsGood);
  return (
    <li
      className="flex animate-fade-up flex-col gap-1 rounded-2xl p-4 surface-raised transition-transform hover:-translate-y-0.5"
      style={{ animationDelay: `${index * 50}ms` }}
      data-testid={testId}
    >
      <p className="text-sm text-muted">{label}</p>
      <AnimatedNumber
        className="text-2xl font-semibold text-text tabular-nums glow-accent sm:text-3xl"
        value={Number(value)}
        text={formatMoney(value, currency, locale)}
        format={{ locale: LOCALE_FORMAT_TAGS[locale], style: "currency", currency }}
      />
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {change === null ? (
          t("noComparison")
        ) : (
          <>
            <Badge tone={good ? "success" : bad ? "danger" : "neutral"}>
              <span aria-hidden="true">{up ? "▲" : down ? "▼" : "■"}</span>
              <span className="ml-1">{change} %</span>
            </Badge>
            {t("vsPrevious")}
          </>
        )}
        {note ? <span>{note}</span> : null}
      </p>
    </li>
  );
}

function Tile({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <li
      className="flex animate-fade-up flex-col rounded-2xl p-4 surface-raised"
      data-testid={testId}
    >
      <p className="mb-1 text-sm text-muted">{label}</p>
      {children}
    </li>
  );
}

function QuickActions({
  t,
  base,
  p,
  sections,
}: {
  t: T;
  base: string;
  p: {
    createDocuments: boolean;
    manageProducts: boolean;
    manageFinance: boolean;
    manageCustomers: boolean;
    useAi: boolean;
    viewReports: boolean;
  };
  sections: { sales: boolean; finance: boolean };
}) {
  const actions = [
    p.createDocuments && {
      href: `${base}/documents/new`,
      label: t("actions.invoice"),
      id: "invoice",
    },
    p.manageProducts && { href: `${base}/products`, label: t("actions.product"), id: "product" },
    p.manageProducts && { href: `${base}/costing`, label: t("actions.costing"), id: "costing" },
    p.manageFinance && { href: `${base}/finance`, label: t("actions.expense"), id: "expense" },
    p.manageCustomers && {
      href: `${base}/customers`,
      label: t("actions.customer"),
      id: "customer",
    },
    p.useAi && { href: `${base}/assistant`, label: t("actions.ai"), id: "ai" },
    sections.sales &&
      sections.finance && {
        href: `${base}/reports?view=receivables`,
        label: t("actions.overdue"),
        id: "overdue",
      },
    p.viewReports && { href: `${base}/reports`, label: t("actions.report"), id: "report" },
  ].filter(Boolean) as { href: string; label: string; id: string }[];
  if (actions.length === 0) return null;
  return (
    <nav
      aria-label={t("actions.title")}
      className="flex flex-wrap gap-2"
      data-testid="quick-actions"
    >
      {actions.map((a) => (
        <Link
          key={a.id}
          href={a.href}
          data-testid={`quick-${a.id}`}
          className="inline-flex min-h-10 items-center rounded-full border border-border bg-surface-2/70 px-3.5 text-sm font-medium text-text transition-[color,border-color,transform] hover:-translate-y-px hover:border-accent/60 active:translate-y-0"
        >
          {a.label}
        </Link>
      ))}
    </nav>
  );
}
