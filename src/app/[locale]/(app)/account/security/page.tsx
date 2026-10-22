import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChangePasswordForm, TwoFactorSettings } from "@/components/auth/two-factor-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert, Button } from "@/components/ui/form";
import { LOCALE_FORMAT_TAGS, type AppLocale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/auth";
import { requirePageUser } from "@/server/auth/page-session";
import { securityData } from "@/server/account/page-data";
import { revokeOtherSessionsAction, revokeSessionAction } from "../actions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "auth.security" });
  return { title: t("title") };
}

export default async function SecurityPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const { sessions, requiredForRole, emailConfigured } = await securityData(user);
  const t = await getTranslations("auth.security");
  const tAuth = await getTranslations("auth");
  const fmt = new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale as AppLocale], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const others = sessions.filter((s) => !s.current);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted">{t("subtitle")}</p>
      </div>
      {!emailConfigured ? <Alert tone="warning">{t("emailNotConfigured")}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("passwordTitle")} />
          <ChangePasswordForm minPasswordLength={PASSWORD_MIN_LENGTH} />
        </Card>

        <Card>
          <CardHeader
            title={t("twoFactorTitle")}
            action={
              <Badge tone={user.twoFactorEnabled ? "success" : "warning"}>
                {user.twoFactorEnabled ? t("twoFactorOn") : t("twoFactorOff")}
              </Badge>
            }
          />
          {!user.twoFactorEnabled ? (
            <div className="space-y-3">
              {requiredForRole ? <Alert tone="warning">{tAuth("setup.required")}</Alert> : null}
              <p className="text-sm text-muted">{tAuth("setup.intro")}</p>
              <Link
                href="/account/two-factor"
                className="inline-flex rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-700"
                data-testid="setup-two-factor"
              >
                {t("enable")}
              </Link>
            </div>
          ) : (
            <TwoFactorSettings enabled={user.twoFactorEnabled} requiredForRole={requiredForRole} />
          )}
        </Card>
      </div>

      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader title={t("sessionsTitle")} description={t("sessionsSubtitle")} />
        </div>
        <ul className="divide-y divide-border border-t border-border" data-testid="sessions-list">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
              data-testid="session-row"
            >
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                  {[s.device.browser, s.device.os].filter(Boolean).join(" · ") ||
                    t("unknownDevice")}
                  {s.current ? <Badge tone="accent">{t("thisDevice")}</Badge> : null}
                  {s.twoFactorVerified ? <Badge tone="success">{t("secondFactor")}</Badge> : null}
                </p>
                {/* Each fact stays on one line; whole facts wrap on narrow screens. */}
                <p className="flex flex-wrap gap-x-2 text-xs text-muted">
                  <span className="whitespace-nowrap">
                    {t("signedIn")}: {fmt.format(s.createdAt)}
                  </span>
                  <span className="whitespace-nowrap">
                    · {t("lastActive")}: {fmt.format(s.lastActiveAt)}
                  </span>
                  {s.ipAddress ? (
                    // An IPv6 address can be longer than a phone screen: it may break anywhere.
                    <span className="min-w-0 break-all">
                      · {t("ipAddress")}: {s.ipAddress}
                    </span>
                  ) : null}
                </p>
              </div>
              <form action={revokeSessionAction}>
                <input type="hidden" name="sessionId" value={s.id} />
                <input type="hidden" name="locale" value={locale} />
                <Button type="submit" variant="secondary" className="px-3 py-1.5">
                  {t("revoke")}
                </Button>
              </form>
            </li>
          ))}
        </ul>
        <div className="border-t border-border px-5 py-4">
          {others.length ? (
            <form action={revokeOtherSessionsAction}>
              <input type="hidden" name="locale" value={locale} />
              <Button type="submit" variant="danger" data-testid="revoke-others">
                {t("revokeOthers")}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted">{t("noOthers")}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
