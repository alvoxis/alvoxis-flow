import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProductionManager } from "@/components/production/production-manager";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { productionPageData } from "@/server/production/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("production") };
}

export default async function CompanyProductionPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await productionPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("production");
  const tNav = await getTranslations("nav");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader title={tNav("production")} description={t("description")} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <ProductionManager
          companyId={companyId}
          today={new Date().toISOString().slice(0, 10)}
          orders={data.orders}
          boms={data.boms}
          catalog={data.catalog}
          canManage={data.canManage}
        />
      )}
    </Card>
  );
}
