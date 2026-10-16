import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { TaxCategoryManager } from "@/components/tax-categories/tax-category-manager";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { taxCategoriesPageData } from "@/server/tax-categories/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "taxCategories" });
  return { title: t("title") };
}

export default async function TaxCategoriesPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await taxCategoriesPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("taxCategories");
  const tDocs = await getTranslations("documents");
  const tCompany = await getTranslations("company");
  const back = (
    <Link
      href={`/companies/${companyId}/documents`}
      className="text-sm text-accent hover:underline"
    >
      {tDocs("back")}
    </Link>
  );
  return (
    <Card>
      <CardHeader title={t("title")} description={t("description")} action={back} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <TaxCategoryManager
          // Remount on server changes (e.g. after "Reload" on a version conflict).
          key={data.categories.map((c) => `${c.id}:${c.version}`).join(",")}
          companyId={companyId}
          categories={data.categories}
          canManage={data.canManage}
        />
      )}
    </Card>
  );
}
