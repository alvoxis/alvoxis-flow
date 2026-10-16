import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { TwoFactorSetup } from "@/components/auth/two-factor-forms";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { requirePageUser } from "@/server/auth/page-session";
import { twoFactorRequiredForRole } from "@/server/account/page-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "auth.setup" });
  return { title: t("title") };
}

/** Enrollment is reachable without a second factor, so a required owner can never be locked out. */
export default async function TwoFactorSetupPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  if (user.twoFactorEnabled) redirect(`/${locale}/account/security`);
  const required = await twoFactorRequiredForRole(user);
  const t = await getTranslations("auth.setup");
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("intro")}</p>
      </div>
      {required ? <Alert tone="warning">{t("required")}</Alert> : null}
      <Card>
        <TwoFactorSetup next="/" />
      </Card>
    </div>
  );
}
