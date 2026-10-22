import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PdfImport } from "@/components/documents/pdf-import";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { importPageData } from "@/server/documents/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "documents.import" });
  return { title: t("title") };
}

/** Import a PDF invoice as a draft (documents.create); the API re-checks access on every call. */
export default async function ImportPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await importPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("documents");
  const tCompany = await getTranslations("company");
  const back = (
    <Link
      href={`/companies/${companyId}/documents`}
      className="text-sm text-violet-300 hover:underline"
    >
      {t("back")}
    </Link>
  );
  return (
    <Card>
      <CardHeader title={t("import.title")} description={t("import.description")} action={back} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <PdfImport
          companyId={companyId}
          companyName={data.companyName}
          taxCategories={data.taxCategories.map((c) => ({
            id: c.id,
            label: c.label,
            code: c.code,
          }))}
          bankAccounts={data.bankAccounts}
        />
      )}
    </Card>
  );
}
