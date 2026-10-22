import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { analyticsPageData } from "@/server/analytics/page-data";
import { requirePageUser } from "@/server/auth/page-session";

type Params = {
  params: Promise<{ locale: Locale; companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("analytics") };
}

export default async function CompanyAnalyticsPage({ params, searchParams }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const year = (await searchParams).year;
  const data = await analyticsPageData(
    user,
    companyId,
    typeof year === "string" ? year : undefined,
  );
  if (data.status === "not_found") notFound();
  const t = await getTranslations("analytics");
  const tNav = await getTranslations("nav");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader title={tNav("analytics")} description={t("description")} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <AnalyticsView companyId={companyId} data={data.data} />
      )}
    </Card>
  );
}
