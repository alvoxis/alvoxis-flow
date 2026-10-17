import { type Metadata } from "next";
import { type Locale, useLocale, useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CreateCompanyForm } from "@/components/dashboard/create-company-form";
import { type CurrencyTotal, type DocumentsOverview } from "@/features/dashboard/summary";
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
  if (totals.length === 0) return <>—</>;
  return totals.map((x, i) => (
    <span key={x.currency} data-currency={x.currency}>
      {i > 0 ? " · " : null}
      {formatMoney(x.amount, x.currency, locale)}
    </span>
  ));
}

function DocumentsFigures({ overview }: { overview: DocumentsOverview }) {
  const t = useTranslations("dashboard.documents");
  return (
    <dl className="grid grid-cols-3 gap-3 text-sm" data-testid="company-documents-overview">
      <div>
        <dt className="text-xs text-muted">{t("drafts")}</dt>
        <dd className="tabular text-lg font-semibold text-text" data-testid="overview-drafts">
          {overview.drafts}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">{t("issued")}</dt>
        <dd className="tabular text-lg font-semibold text-text" data-testid="overview-issued">
          {overview.issued}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted">{t("issuedTotal")}</dt>
        <dd className="tabular font-semibold break-words text-text" data-testid="overview-totals">
          <Totals totals={overview.issuedTotals} />
        </dd>
      </div>
    </dl>
  );
}

export default async function DashboardPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const tOn = await getTranslations("onboarding");
  const tRoles = await getTranslations("roles");
  const tDocs = await getTranslations("documents");
  const tCat = await getTranslations("taxCategories");
  const tBank = await getTranslations("bankAccounts");
  const tOverview = await getTranslations("dashboard.documents");
  const user = await requirePageUser(locale);
  const { companies, twoFactorMissing } = await dashboardData(user);

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
                  <Link
                    href={`/companies/${c.id}/tax-categories`}
                    className="text-accent hover:underline"
                    data-testid="company-tax-categories-link"
                  >
                    {tCat("open")}
                  </Link>
                  <Link
                    href={`/companies/${c.id}/bank-accounts`}
                    className="text-accent hover:underline"
                    data-testid="company-bank-accounts-link"
                  >
                    {tBank("open")}
                  </Link>
                  {tOn(`countries.${c.country}`)}
                  <Badge tone="accent">{tRoles(c.roleKey as "owner")}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {companies.length > 0 ? (
        <div data-testid="documents-overview">
          <Card>
            <CardHeader title={tOverview("title")} />
            <ul className="space-y-4">
              {companies.map((c) => (
                <li key={c.id} className="space-y-2" data-company-id={c.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-text">{c.name}</p>
                    {c.documents ? (
                      <Link
                        href={`/companies/${c.id}/documents`}
                        className="text-sm text-accent hover:underline"
                      >
                        {tDocs("open")}
                      </Link>
                    ) : null}
                  </div>
                  {c.documents === null ? (
                    <p className="text-sm text-muted" data-testid="overview-unavailable">
                      {tOverview("unavailable")}
                    </p>
                  ) : c.documents.drafts + c.documents.issued === 0 ? (
                    <p className="text-sm text-muted" data-testid="overview-empty">
                      {tOverview("empty")}
                    </p>
                  ) : (
                    <DocumentsFigures overview={c.documents} />
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted">{tOverview("currencyNote")}</p>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
