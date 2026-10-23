import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CounterpartyManager } from "@/components/counterparties/counterparty-manager";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { counterpartiesPageData } from "@/server/counterparties/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("customers") };
}

export default async function CompanyCustomersPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await counterpartiesPageData(user, companyId, "customer");
  if (data.status === "not_found") notFound();
  const t = await getTranslations("counterparties");
  const tNav = await getTranslations("nav");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader title={tNav("customers")} description={t("description.customer")} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <CounterpartyManager
          // Remount on server changes (e.g. after "Reload" on a version conflict).
          key={data.items.map((c) => `${c.id}:${c.version}`).join(",")}
          companyId={companyId}
          kind="customer"
          items={data.items}
          canManage={data.canManage}
          canViewDocuments={data.canViewDocuments}
        />
      )}
    </Card>
  );
}
