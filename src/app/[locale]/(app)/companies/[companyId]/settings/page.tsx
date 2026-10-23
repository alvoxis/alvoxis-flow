import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { InvitationsManager } from "@/components/settings/invitations-manager";
import { MembersManager } from "@/components/settings/members-manager";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { settingsPageData } from "@/server/settings/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("settings") };
}

/** Company settings hub: links to the settings pages the role may open, members, own account. */
export default async function CompanySettingsPage({ params }: Params) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await settingsPageData(user, companyId);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("settings");
  const tNav = await getTranslations("nav");
  const tCompany = await getTranslations("company");
  const tInvitations = await getTranslations("invitations");
  if (data.status === "two_factor_required")
    return (
      <Card>
        <CardHeader title={tNav("settings")} description={t("description")} />
        <Alert tone="warning">
          {tCompany("twoFactorRequired")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      </Card>
    );
  const { access, members, invitations } = data;
  const base = `/companies/${companyId}`;
  const links = [
    access.profile && { href: `${base}/profile`, key: "profile" },
    access.taxCategories && { href: `${base}/tax-categories`, key: "taxCategories" },
    access.bankAccounts && { href: `${base}/bank-accounts`, key: "bankAccounts" },
    access.warehouses && { href: `${base}/inventory`, key: "warehouses" },
    access.payrollRates && { href: `${base}/payroll`, key: "payrollRates" },
  ].filter((l): l is { href: string; key: string } => Boolean(l));
  const account = [
    { href: "/account/security", key: "security" },
    { href: "/account/two-factor", key: "twoFactor" },
  ];
  const linkClass =
    "block rounded-xl border border-border p-3 hover:border-accent/60 focus-visible:border-accent";
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={tNav("settings")} description={t("description")} />
        <section className="space-y-3" aria-labelledby="company-settings">
          <h3 id="company-settings" className="text-sm font-semibold text-text">
            {t("company")}
          </h3>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="settings-links">
            {links.map((l) => (
              <li key={l.key}>
                <Link href={l.href} className={linkClass} data-testid={`settings-${l.key}`}>
                  <span className="block font-medium text-text">
                    {t(`links.${l.key}.title` as Parameters<typeof t>[0])}
                  </span>
                  <span className="block text-sm text-muted">
                    {t(`links.${l.key}.text` as Parameters<typeof t>[0])}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </Card>
      {members ? (
        <Card>
          <CardHeader title={t("members.title")} description={t("members.description")} />
          <MembersManager
            companyId={companyId}
            members={members.members}
            roles={members.roles}
            canManage={access.manageMembers}
            actorIsOwner={access.roleKey === "owner"}
          />
        </Card>
      ) : null}
      {members && invitations ? (
        <Card>
          <CardHeader title={tInvitations("title")} description={tInvitations("description")} />
          <InvitationsManager
            companyId={companyId}
            invitations={invitations}
            roles={members.roles}
            canManage={access.manageMembers}
            actorIsOwner={access.roleKey === "owner"}
          />
        </Card>
      ) : null}
      <Card>
        <CardHeader title={t("account")} />
        <ul className="grid gap-3 sm:grid-cols-2">
          {account.map((l) => (
            <li key={l.key}>
              <Link href={l.href} className={linkClass}>
                <span className="block font-medium text-text">
                  {t(`links.${l.key}.title` as Parameters<typeof t>[0])}
                </span>
                <span className="block text-sm text-muted">
                  {t(`links.${l.key}.text` as Parameters<typeof t>[0])}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
