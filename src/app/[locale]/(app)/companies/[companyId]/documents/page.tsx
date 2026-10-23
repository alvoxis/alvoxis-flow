import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocumentFilters, DocumentPagination } from "@/components/documents/document-filters";
import { DocumentList } from "@/components/documents/document-list";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import {
  isFiltered,
  pageRange,
  parseDocumentListQuery,
  toQueryString,
} from "@/features/documents/list-query";
import { Link, redirect } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { documentsListData } from "@/server/documents/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "documents" });
  return { title: t("title") };
}

export default async function DocumentsPage({ params, searchParams }: Props) {
  const { locale, companyId } = await params;
  const search = await searchParams;
  const deleted = search.deleted;
  const query = parseDocumentListQuery(search);
  setRequestLocale(locale);
  // The filter form submits every field as typed (empty ones, extra spaces): show the clean,
  // canonical URL instead, so it can be shared and compared. Parsing it again is a no-op.
  const canonical = toQueryString(query);
  const { deleted: _deleted, ...listParams } = search;
  const raw = new URLSearchParams(
    Object.entries(listParams).flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v ?? ""]).map((x) => [k, x]),
    ),
  ).toString();
  if (raw !== canonical.slice(1)) {
    const keepDeleted = deleted === "1" ? `${canonical ? "&" : "?"}deleted=1` : "";
    redirect({ href: `/companies/${companyId}/documents${canonical}${keepDeleted}`, locale });
  }
  const user = await requirePageUser(locale);
  const data = await documentsListData(user, companyId, query);
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
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/companies/${companyId}/documents/import`}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text hover:border-accent/60"
                data-testid="import-pdf-link"
              >
                {t("import.open")}
              </Link>
              <Link
                href={`/companies/${companyId}/documents/new`}
                className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
                data-testid="new-document-link"
              >
                {t("new.title")}
              </Link>
            </div>
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
          <DocumentFilters companyId={companyId} query={query} />
          <DocumentList
            companyId={companyId}
            rows={data.documents}
            canDelete={data.permissions.canEdit}
            backQuery={toQueryString(query)}
            filtered={isFiltered(query)}
          />
          {data.total > 0 ? (
            <DocumentPagination
              companyId={companyId}
              page={query.page}
              total={data.total}
              {...pageRange(query.page, data.total)}
              hrefFor={(page) => toQueryString(query, { page })}
            />
          ) : null}
        </div>
      )}
    </Card>
  );
}
