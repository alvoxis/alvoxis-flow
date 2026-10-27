import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CostCalculator } from "@/components/costing/cost-calculator";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { costingPageData } from "@/server/costing/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("costing") };
}

/** The full product cost calculator with saved calculations (products.view). */
export default async function CostingPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await costingPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("costing");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader title={t("title")} description={t("description")} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <CostCalculator
          key={data.saved.map((c) => `${c.id}:${c.version}`).join(",")}
          companyId={companyId}
          saved={data.saved}
          products={data.products}
          canManage={data.canManage}
        />
      )}
    </Card>
  );
}
