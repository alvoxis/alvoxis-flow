import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { Alert } from "@/components/ui/form";
import { getMailer, isGoogleConfigured } from "@/server/auth/instance";
import { optionalPageUser } from "@/server/auth/page-session";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "auth.signIn" });
  return { title: t("title") };
}

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const user = await optionalPageUser();
  if (user?.twoFactorVerified || (user && !user.twoFactorEnabled)) redirect(`/${locale}`);
  const t = await getTranslations("auth");

  return (
    <AuthCard title={t("signIn.title")} subtitle={t("signIn.subtitle")}>
      {sp.verified && !sp.error ? <Alert tone="success">{t("signIn.verified")}</Alert> : null}
      {sp.verified && sp.error ? <Alert tone="error">{t("signIn.verifyFailed")}</Alert> : null}
      {sp.reset ? <Alert tone="success">{t("signIn.resetDone")}</Alert> : null}
      {sp.error && !sp.verified ? <Alert tone="error">{t("errors.generic")}</Alert> : null}
      <SignInForm
        googleEnabled={isGoogleConfigured()}
        emailConfigured={getMailer().configured}
        next={sp.next}
      />
    </AuthCard>
  );
}
