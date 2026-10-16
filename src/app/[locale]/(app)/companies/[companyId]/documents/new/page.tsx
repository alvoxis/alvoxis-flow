import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { NewDocumentForm } from "@/components/documents/new-document-form";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { newDocumentPageData } from "@/server/documents/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "documents" });
  return { title: t("new.title") };
}

export default async function NewDocumentPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await newDocumentPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("documents");
  const tCompany = await getTranslations("company");
  const back = (
    <Link
      href={`/companies/${companyId}/documents`}
      className="text-sm text-accent hover:underline"
    >
      {t("back")}
    </Link>
  );
  return (
    <Card>
      <CardHeader title={t("new.title")} action={back} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : data.permissions.canEdit ? (
        <NewDocumentForm companyId={companyId} bankAccounts={data.bankAccounts} />
      ) : (
        <Alert tone="info">{t("new.cannotCreate")}</Alert>
      )}
    </Card>
  );
}
