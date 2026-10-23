import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CompanyProfileForm } from "@/components/company/company-profile-form";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { companyProfileData } from "@/server/account/page-data";
import { requirePageUser } from "@/server/auth/page-session";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "company" });
  return { title: t("title") };
}

export default async function CompanyProfilePage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await companyProfileData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("company");
  if (data.status === "two_factor_required") {
    return (
      <Card>
        <CardHeader title={t("title")} />
        <Alert tone="warning">
          {t("twoFactorRequired")} <Link href="/account/two-factor">{t("setUpTwoFactor")}</Link>
        </Alert>
      </Card>
    );
  }
  const tOn = await getTranslations("onboarding");
  const { profile, canEdit } = data.view;
  return (
    <Card>
      <CardHeader title={t("title")} description={t("description")} />
      <CompanyProfileForm
        companyId={profile.id}
        canEdit={canEdit}
        country={profile.country}
        countryName={tOn(`countries.${profile.country}`)}
        pdfAccent={profile.pdfAccent}
        values={{
          name: profile.name,
          legalName: profile.legalName,
          registrationNumber: profile.registrationNumber,
          vatNumber: profile.vatNumber,
          addressLine1: profile.addressLine1,
          addressLine2: profile.addressLine2,
          postalCode: profile.postalCode,
          city: profile.city,
        }}
      />
    </Card>
  );
}
