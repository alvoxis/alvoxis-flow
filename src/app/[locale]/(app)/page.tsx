import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CompanyOverviewCard } from "@/components/dashboard/company-overview-card";
import { CreateCompanyForm } from "@/components/dashboard/create-company-form";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
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

export default async function DashboardPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const tOn = await getTranslations("onboarding");
  const tOverview = await getTranslations("dashboard.documents");
  const user = await requirePageUser(locale);
  const { companies, twoFactorMissing } = await dashboardData(user);

  return (
    <div className="space-y-8">
      <header className="relative isolate">
        {/* Soft accent glow behind the title: a static gradient, clipped to the page width. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-10 -z-10 h-44 overflow-hidden"
        >
          <div className="mx-auto h-full max-w-2xl bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-accent-strong)_28%,transparent),transparent)]" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">
          {t("title")}
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted sm:text-base">{t("subtitle")}</p>
      </header>

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
        <section
          aria-labelledby="dashboard-companies"
          className="space-y-4"
          data-testid="documents-overview"
        >
          <h2
            id="dashboard-companies"
            className="text-xs font-semibold tracking-wider text-muted uppercase"
          >
            {tOn("yourCompanies")}
          </h2>
          {/* One card per company: who it is, its real document figures and the ways into it. */}
          <ul
            className={cn("grid gap-4", companies.length > 1 && "lg:grid-cols-2")}
            data-testid="company-list"
          >
            {companies.map((c) => (
              <CompanyOverviewCard key={c.id} company={c} />
            ))}
          </ul>
          <p className="text-xs text-muted">{tOverview("currencyNote")}</p>
        </section>
      )}
    </div>
  );
}
