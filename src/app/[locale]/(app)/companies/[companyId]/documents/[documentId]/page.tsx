import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocumentEditor } from "@/components/documents/document-editor";
import { DocumentStatusBadge } from "@/components/documents/document-status-badge";
import { DocumentView } from "@/components/documents/document-view";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { documentPageData } from "@/server/documents/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string; documentId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "documents" });
  return { title: t("title") };
}

export default async function DocumentPage({ params }: Params) {
  const { locale, companyId, documentId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await documentPageData(user, companyId, documentId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("documents");
  const tCompany = await getTranslations("company");
  const tType = await getTranslations("documentPdf.title");
  const back = (
    <Link
      href={`/companies/${companyId}/documents`}
      className="text-sm text-accent hover:underline"
    >
      {t("back")}
    </Link>
  );
  if (data.status === "two_factor_required") {
    return (
      <Card>
        <CardHeader title={t("title")} action={back} />
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      </Card>
    );
  }
  const { document, permissions } = data;
  const issued = document.status === "issued";
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span data-testid="document-heading">
              {tType(document.draft.type)} {document.number ?? `(${t("draftHeading")})`}
            </span>
            <DocumentStatusBadge status={document.status} />
          </span>
        }
        action={back}
      />
      {issued ? (
        <div className="space-y-6">
          <Alert tone="success">
            <span data-testid="issued-notice">
              {t("issuedNotice", { number: document.number ?? "" })}
            </span>
          </Alert>
          <DocumentView document={document} />
        </div>
      ) : (
        <DocumentEditor
          key={document.version}
          companyId={companyId}
          document={document}
          canEdit={permissions.canEdit}
          canIssue={permissions.canIssue}
          taxCategories={data.taxCategories}
          canManageTaxCategories={permissions.canManageTaxCategories}
        />
      )}
    </Card>
  );
}
