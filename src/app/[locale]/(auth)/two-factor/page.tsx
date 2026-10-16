import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SignOutButton, TwoFactorChallengeForm } from "@/components/auth/two-factor-forms";
import { Alert } from "@/components/ui/form";
import { optionalPageUser } from "@/server/auth/page-session";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "auth.twoFactor" });
  return { title: t("title") };
}

export default async function TwoFactorPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await optionalPageUser();
  // A fully verified session (or one without 2FA) has nothing to confirm here.
  if (user && (user.twoFactorVerified || !user.twoFactorEnabled)) redirect(`/${locale}`);
  const t = await getTranslations("auth.twoFactor");
  return (
    <AuthCard title={t("title")} subtitle={t("subtitle")}>
      {user ? <Alert tone="info">{t("stepUp")}</Alert> : null}
      <TwoFactorChallengeForm />
      {user ? <SignOutButton label={t("signOut")} className="w-full" /> : null}
    </AuthCard>
  );
}
