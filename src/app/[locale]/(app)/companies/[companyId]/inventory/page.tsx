import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { InventoryManager } from "@/components/inventory/inventory-manager";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { inventoryPageData } from "@/server/inventory/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("inventory") };
}

export default async function CompanyInventoryPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await inventoryPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("inventory");
  const tNav = await getTranslations("nav");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader title={tNav("inventory")} description={t("description")} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <InventoryManager
          companyId={companyId}
          today={new Date().toISOString().slice(0, 10)}
          warehouses={data.warehouses}
          stock={data.stock}
          movements={data.movements}
          productNames={data.productNames}
          canManage={data.canManage}
        />
      )}
    </Card>
  );
}
