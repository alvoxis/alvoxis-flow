import { type ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requirePageUser } from "@/server/auth/page-session";
import { subscriptionBanner } from "@/server/billing/page-data";

/**
 * Every page of a company: a banner when the company is read-only for lack of an active
 * subscription, or when the last payment failed. The pages themselves enforce access; this only
 * explains why controls are missing and where to restore them.
 */
export default async function CompanyLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; companyId: string }>;
}) {
  const { locale, companyId } = await params;
  const user = await requirePageUser(locale);
  const banner = await subscriptionBanner(user, companyId);
  const t = await getTranslations("billing.banner");
  return (
    <>
      {banner ? (
        <div
          role="status"
          data-testid="subscription-banner"
          data-kind={banner.kind}
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-text"
        >
          <p>{banner.kind === "read_only" ? t("readOnly") : t("pastDue")}</p>
          {banner.canManageBilling ? (
            <Link
              href={`/companies/${companyId}/billing`}
              className="rounded-lg bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90"
            >
              {t("open")}
            </Link>
          ) : null}
        </div>
      ) : null}
      {children}
    </>
  );
}
