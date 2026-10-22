import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProductManager } from "@/components/products/product-manager";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { productsPageData } from "@/server/products/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("products") };
}

export default async function CompanyProductsPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await productsPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("products");
  const tNav = await getTranslations("nav");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader title={tNav("products")} description={t("description")} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <ProductManager
          // Remount on server changes (e.g. after "Reload" on a version conflict).
          key={data.items.map((p) => `${p.id}:${p.version}`).join(",")}
          companyId={companyId}
          items={data.items}
          categories={data.categories}
          categoryNames={data.categoryNames}
          canManage={data.canManage}
        />
      )}
    </Card>
  );
}
