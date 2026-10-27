import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AssistantChat } from "@/components/ai/assistant-chat";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { assistantPageData } from "@/server/ai/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("assistant") };
}

/** The AI business assistant of a company (ai.use). */
export default async function AssistantPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await assistantPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("assistant");
  const tCompany = await getTranslations("company");
  return (
    <Card>
      <CardHeader title={t("title")} description={t("description")} />
      {data.status === "two_factor_required" ? (
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      ) : !data.assistant.configured ? (
        <Alert tone="info">
          <span data-testid="assistant-not-configured">{t("notConfigured")}</span>
        </Alert>
      ) : data.assistant.readOnly ? (
        <Alert tone="warning">
          {t("readOnly")} <Link href={`/companies/${companyId}/billing`}>{t("toBilling")}</Link>
        </Alert>
      ) : !data.assistant.canUse ? (
        <Alert tone="info">{t("noPermission")}</Alert>
      ) : (
        <div className="space-y-4">
          <AssistantChat companyId={companyId} remaining={data.assistant.remainingThisMonth} />
        </div>
      )}
      <p className="mt-6 text-xs text-muted" data-testid="assistant-privacy">
        {t("privacy")}
      </p>
    </Card>
  );
}
