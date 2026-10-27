import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ExpenseManager } from "@/components/finance/expense-manager";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { expensesPageData, parseExpenseQuery } from "@/server/finance/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("finance") };
}

/** Expenses of the company (finance.view); the URL carries search, filters, sort and page. */
export default async function CompanyFinancePage({ params, searchParams }: Props) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const query = parseExpenseQuery(await searchParams);
  const data = await expensesPageData(user, companyId, query);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("finance");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader
        title={t("title")}
        description={t("description")}
        action={
          <Link
            href={`/companies/${companyId}/reports`}
            className="text-sm text-accent hover:underline"
          >
            {t("toReports")}
          </Link>
        }
      />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <ExpenseManager
          companyId={companyId}
          expenses={data.expenses}
          total={data.total}
          pageSize={data.pageSize}
          query={data.query}
          canManage={data.canManage}
          suppliers={data.suppliers}
        />
      )}
    </Card>
  );
}
