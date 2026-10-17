import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardHeader } from "@/components/ui/card";
import { Link, redirect } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { documentsEntryData } from "@/server/account/page-data";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "documents" });
  return { title: t("title") };
}

/**
 * "Documents" in the main navigation. Documents belong to a company: with one company this goes
 * straight to its list (the company page checks access as usual); with several the user picks
 * one; without a company it points to creating one on the dashboard.
 */
export default async function DocumentsEntryPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale, "/documents");
  const companies = await documentsEntryData(user);
  if (companies.length === 1)
    redirect({ href: `/companies/${companies[0]!.id}/documents`, locale });

  const t = await getTranslations("documents.entry");
  return (
    <Card>
      <CardHeader title={t("title")} description={companies.length ? t("choose") : t("none")} />
      {companies.length ? (
        <ul className="divide-y divide-border" data-testid="documents-company-list">
          {companies.map((c) => (
            <li key={c.id} className="py-2.5 text-sm">
              <Link
                href={`/companies/${c.id}/documents`}
                className="font-medium text-text hover:text-accent"
              >
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Link
          href="/"
          className="inline-block rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-accent"
          data-testid="documents-create-company-link"
        >
          {t("createCompany")}
        </Link>
      )}
    </Card>
  );
}
