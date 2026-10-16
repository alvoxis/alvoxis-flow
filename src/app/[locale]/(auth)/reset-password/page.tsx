import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/password-reset-forms";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/auth";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "auth.reset" });
  return { title: t("title") };
}

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const t = await getTranslations("auth.reset");
  // The auth handler redirects here with ?token=… (valid link) or ?error=INVALID_TOKEN.
  const token = !sp.error && sp.token && /^[A-Za-z0-9_-]{16,200}$/.test(sp.token) ? sp.token : null;
  return (
    <AuthCard title={t("title")}>
      <ResetPasswordForm token={token} minPasswordLength={PASSWORD_MIN_LENGTH} />
    </AuthCard>
  );
}
