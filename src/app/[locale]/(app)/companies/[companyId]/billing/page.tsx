import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BillingPanel } from "@/components/billing/billing-panel";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { billingPageData } from "@/server/billing/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };
type Props = Params & { searchParams: Promise<{ checkout?: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "billing" });
  return { title: t("title") };
}

/** Subscription of the company (owners): the one plan, Stripe Checkout, portal and history. */
export default async function BillingPage({ params, searchParams }: Props) {
  const { locale, companyId } = await params;
  const { checkout } = await searchParams;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await billingPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("billing");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader
        title={t("title")}
        description={t("description")}
        action={
          <Link href={`/companies/${companyId}/settings`} className="text-sm text-violet-300">
            {t("back")}
          </Link>
        }
      />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : (
        <BillingPanel
          companyId={companyId}
          billing={data.billing}
          invoices={data.invoices}
          checkout={checkout === "success" || checkout === "cancelled" ? checkout : null}
        />
      )}
    </Card>
  );
}
