import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/auth";
import { getMailer } from "@/server/auth/instance";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "auth.signUp" });
  return { title: t("title") };
}

export default async function SignUpPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth.signUp");
  return (
    <AuthCard title={t("title")} subtitle={t("subtitle")}>
      <SignUpForm
        minPasswordLength={PASSWORD_MIN_LENGTH}
        emailConfigured={getMailer().configured}
      />
    </AuthCard>
  );
}
