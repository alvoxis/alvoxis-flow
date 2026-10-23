import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { InvitationAccept } from "@/components/settings/invitation-accept";
import { Alert } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { invitationPageData } from "@/server/settings/page-data";

type Params = { params: Promise<{ locale: Locale; token: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "invitations" });
  return { title: t("title"), robots: { index: false } };
}

/**
 * Invitation link: signed-in users see the company and role and accept; others sign in first and
 * come back here. Unknown, used and expired links reveal nothing about the company.
 */
export default async function InvitationPage({ params }: Params) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale, `/invitations/${token}`);
  const t = await getTranslations("invitations");
  const tRoles = await getTranslations("roles");
  const found = await invitationPageData(user, token);
  const home = (
    <Link href="/" className="block text-sm">
      {t("home")}
    </Link>
  );
  if (found.status !== "open")
    return (
      <AuthCard title={t("title")}>
        <Alert tone="error">{t(`closed.${found.status}`)}</Alert>
        {home}
      </AuthCard>
    );
  const role = tRoles.has(found.roleKey as Parameters<typeof tRoles>[0])
    ? tRoles(found.roleKey as Parameters<typeof tRoles>[0])
    : found.roleName;
  return (
    <AuthCard title={t("title")} subtitle={t("intro", { company: found.companyName, role })}>
      {found.alreadyMember ? (
        <>
          <Alert tone="info">{t("state.invitation.alreadyMember")}</Alert>
          {home}
        </>
      ) : !found.emailMatches ? (
        <>
          <Alert tone="warning">{t("otherEmail", { email: user.email })}</Alert>
          {home}
        </>
      ) : (
        <InvitationAccept token={token} />
      )}
    </AuthCard>
  );
}
