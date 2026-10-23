import { getTranslations } from "next-intl/server";
import { Card, CardHeader } from "@/components/ui/card";
import { Link, redirect } from "@/i18n/navigation";
import { type Locale } from "next-intl";

/**
 * Entry of a company module in the main navigation (customers, products…). The module belongs to
 * a company: with one company this goes straight to its page (which checks access as usual); with
 * several the user picks one; without a company it points to creating one on the dashboard.
 */
export async function CompanyEntry({
  locale,
  title,
  section,
  companies,
}: {
  locale: Locale;
  title: string;
  /** Path segment under /companies/[id]/, e.g. "customers". */
  section: string;
  companies: { id: string; name: string }[];
}) {
  if (companies.length === 1)
    redirect({ href: `/companies/${companies[0]!.id}/${section}`, locale });
  const t = await getTranslations("records.entry");
  return (
    <Card>
      <CardHeader title={title} description={companies.length ? t("choose") : t("none")} />
      {companies.length ? (
        <ul className="divide-y divide-border" data-testid="module-company-list">
          {companies.map((c) => (
            <li key={c.id} className="py-2.5 text-sm">
              <Link
                href={`/companies/${c.id}/${section}`}
                className="font-medium break-words text-text hover:text-violet-300"
              >
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Link
          href="/"
          className="inline-block rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
        >
          {t("createCompany")}
        </Link>
      )}
    </Card>
  );
}
