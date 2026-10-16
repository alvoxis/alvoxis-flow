import { type Metadata } from "next";
import { type Locale, useLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CreateCompanyForm } from "@/components/dashboard/create-company-form";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { NextSteps } from "@/components/dashboard/next-steps";
import { RecentDocuments } from "@/components/dashboard/recent-documents";
import { SAMPLE_DOCUMENTS, SAMPLE_MONTH } from "@/features/dashboard/sample-data";
import { computeDashboardSummary, type CurrencyTotal } from "@/features/dashboard/summary";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/format";
import { requirePageUser } from "@/server/auth/page-session";
import { dashboardData } from "@/server/account/page-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("title") };
}

function Totals({ totals }: { totals: CurrencyTotal[] }) {
  const locale = useLocale();
  if (totals.length === 0) return <p>—</p>;
  return totals.map((x) => (
    <p key={x.currency} data-currency={x.currency}>
      {formatMoney(x.amount, x.currency, locale)}
    </p>
  ));
}

export default async function DashboardPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const tOn = await getTranslations("onboarding");
  const tRoles = await getTranslations("roles");
  const tDocs = await getTranslations("documents");
  const user = await requirePageUser(locale);
  const { companies, twoFactorMissing } = await dashboardData(user);

  // Sample data until the documents module and authentication exist (see docs/ROADMAP.md).
  const summary = computeDashboardSummary(SAMPLE_DOCUMENTS, SAMPLE_MONTH);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted">{t("subtitle")}</p>
        </div>
      </div>

      {twoFactorMissing ? (
        <div
          role="alert"
          data-testid="two-factor-required"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/50 bg-accent-soft/70 px-4 py-3"
        >
          <div>
            <p className="text-sm font-semibold text-violet-100">{tOn("twoFactorRequiredTitle")}</p>
            <p className="text-sm text-violet-200/90">{tOn("twoFactorRequiredBody")}</p>
          </div>
          <Link
            href="/account/two-factor"
            className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-accent"
          >
            {tOn("setUpNow")}
          </Link>
        </div>
      ) : null}

      {companies.length === 0 ? (
        <CreateCompanyForm />
      ) : (
        <Card>
          <CardHeader title={tOn("yourCompanies")} />
          <ul className="divide-y divide-border" data-testid="company-list">
            {companies.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <Link
                  href={`/companies/${c.id}/profile`}
                  className="font-medium text-text hover:text-accent"
                  data-testid="company-profile-link"
                >
                  {c.name}
                </Link>
                <span className="flex flex-wrap items-center justify-end gap-2 text-muted">
                  <Link
                    href={`/companies/${c.id}/documents`}
                    className="text-accent hover:underline"
                    data-testid="company-documents-link"
                  >
                    {tDocs("open")}
                  </Link>
                  {tOn(`countries.${c.country}`)}
                  <Badge tone="accent">{tRoles(c.roleKey as "owner")}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div
        role="note"
        data-testid="sample-data-banner"
        className="flex items-start gap-3 rounded-xl border border-amber-800/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="mt-0.5 size-4 shrink-0 text-warning"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
        <p>{t("demoBanner")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="kpi-grid">
        <KpiCard label={t("kpi.revenue")} hint={t("kpi.revenueHint")}>
          <Totals totals={summary.invoicedByCurrency} />
        </KpiCard>
        <KpiCard
          label={t("kpi.outstanding")}
          hint={t("kpi.outstandingHint", { count: summary.outstandingCount })}
        >
          <Totals totals={summary.outstandingByCurrency} />
        </KpiCard>
        <KpiCard
          label={t("kpi.overdue")}
          hint={t("kpi.overdueHint", { count: summary.overdueCount })}
          tone={summary.overdueCount > 0 ? "danger" : "default"}
        >
          <Totals totals={summary.overdueByCurrency} />
        </KpiCard>
        <KpiCard label={t("kpi.documents")} hint={t("kpi.documentsHint")}>
          <p>{summary.documentCount}</p>
        </KpiCard>
      </div>

      <p className="text-xs text-muted">{t("currencyNote")}</p>

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_20rem]">
        <RecentDocuments documents={SAMPLE_DOCUMENTS} />
        <NextSteps />
      </div>
    </div>
  );
}
