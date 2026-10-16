import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocumentList } from "@/components/documents/document-list";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { documentsListData } from "@/server/documents/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };
type Props = Params & { searchParams: Promise<{ deleted?: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "documents" });
  return { title: t("title") };
}

export default async function DocumentsPage({ params, searchParams }: Props) {
  const { locale, companyId } = await params;
  const { deleted } = await searchParams;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await documentsListData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("documents");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader
        title={t("title")}
        description={t("description")}
        action={
          data.status === "ok" && data.permissions.canEdit ? (
            <Link
              href={`/companies/${companyId}/documents/new`}
              className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-accent"
              data-testid="new-document-link"
            >
              {t("new.title")}
            </Link>
          ) : null
        }
      />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <div className="space-y-4">
          {deleted === "1" ? <Alert tone="success">{t("deleted")}</Alert> : null}
          {data.hasTaxCategories ? null : (
            <div data-testid="no-tax-categories">
              <Alert tone="info">
                {data.permissions.canManageTaxCategories ? (
                  <>
                    {t("noCategoriesManage")}{" "}
                    <Link href={`/companies/${companyId}/tax-categories`} className="underline">
                      {t("setUpCategories")}
                    </Link>
                  </>
                ) : (
                  t("noCategoriesAsk")
                )}
              </Alert>
            </div>
          )}
          <DocumentList
            companyId={companyId}
            rows={data.documents}
            canDelete={data.permissions.canEdit}
          />
        </div>
      )}
    </Card>
  );
}
