import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { type DocumentsOverview, issuedShare } from "@/features/dashboard/summary";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/format";
import { type dashboardData } from "@/server/account/page-data";

type Company = Awaited<ReturnType<typeof dashboardData>>["companies"][number];

const quickLink =
  "inline-flex min-h-10 items-center rounded-full border border-border bg-surface-2/70 px-3.5 text-sm font-medium text-violet-200 transition-colors hover:border-accent/60 hover:text-violet-100";

/**
 * One company on the dashboard: who it is, its real document figures (or why there are none: no
 * documents yet, no access, or a loading error) and the ways into it. Server-rendered; the depth comes from CSS only (surface-raised).
 */
export function CompanyOverviewCard({ company: c }: { company: Company }) {
  const tOn = useTranslations("onboarding");
  const tRoles = useTranslations("roles");
  const tDocs = useTranslations("documents");
  const tCat = useTranslations("taxCategories");
  const tBank = useTranslations("bankAccounts");
  const t = useTranslations("dashboard.documents");

  return (
    <li
      data-company-id={c.id}
      className="flex min-w-0 flex-col gap-5 rounded-2xl p-5 surface-raised transition-shadow sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/companies/${c.id}/profile`}
            className="block truncate text-lg font-semibold tracking-tight text-text hover:text-violet-200"
            data-testid="company-profile-link"
          >
            {c.name}
          </Link>
          <p className="mt-0.5 text-sm text-muted">{tOn(`countries.${c.country}`)}</p>
        </div>
        <Badge tone="accent">{tRoles(c.roleKey as "owner")}</Badge>
      </div>

      {c.documents.status === "no_access" ? (
        <p
          className="rounded-xl border border-border bg-surface-2/50 px-4 py-3 text-sm text-muted"
          data-testid="overview-unavailable"
        >
          {t("unavailable")}
        </p>
      ) : c.documents.status === "error" ? (
        <p
          role="alert"
          className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-amber-100"
          data-testid="overview-error"
        >
          {t("loadError")}
        </p>
      ) : c.documents.overview.drafts + c.documents.overview.issued === 0 ? (
        <div
          className="space-y-3 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted"
          data-testid="overview-empty"
        >
          <p>{t("empty")}</p>
          {c.documents.canCreate ? (
            <Link
              href={`/companies/${c.id}/documents/new`}
              className="inline-flex min-h-11 items-center rounded-lg bg-accent-strong px-4 text-sm font-medium text-white hover:bg-violet-700"
              data-testid="overview-create-document"
            >
              {t("createFirst")}
            </Link>
          ) : null}
        </div>
      ) : (
        <DocumentsFigures overview={c.documents.overview} companyId={c.id} />
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        <Link
          href={`/companies/${c.id}/documents`}
          className={quickLink}
          data-testid="company-documents-link"
        >
          {tDocs("open")}
        </Link>
        <Link
          href={`/companies/${c.id}/tax-categories`}
          className={quickLink}
          data-testid="company-tax-categories-link"
        >
          {tCat("open")}
        </Link>
        <Link
          href={`/companies/${c.id}/bank-accounts`}
          className={quickLink}
          data-testid="company-bank-accounts-link"
        >
          {tBank("open")}
        </Link>
      </div>
    </li>
  );
}

function DocumentsFigures({
  overview,
  companyId,
}: {
  overview: DocumentsOverview;
  companyId: string;
}) {
  const t = useTranslations("dashboard.documents");
  const locale = useLocale();
  const share = issuedShare(overview);
  // Unique per card (a UUID); safe inside url(#…).
  const gradientId = `share-${companyId}`;

  return (
    <div className="space-y-4" data-testid="company-documents-overview">
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-surface-2/60 px-4 py-3">
          <dt className="text-xs font-medium tracking-wide text-muted uppercase">{t("drafts")}</dt>
          <dd
            className="tabular mt-1 text-2xl font-semibold text-text"
            data-testid="overview-drafts"
          >
            {overview.drafts}
          </dd>
        </div>
        <div className="rounded-xl bg-surface-2/60 px-4 py-3">
          <dt className="text-xs font-medium tracking-wide text-muted uppercase">{t("issued")}</dt>
          <dd
            className="tabular mt-1 text-2xl font-semibold text-text"
            data-testid="overview-issued"
          >
            {overview.issued}
          </dd>
        </div>
        <div className="col-span-2 min-w-0 rounded-xl bg-accent-soft/40 px-4 py-3 ring-1 ring-accent/25 ring-inset">
          <dt className="text-xs font-medium tracking-wide text-violet-200 uppercase">
            {t("invoicedNet")}
          </dt>
          <dd
            className="tabular mt-1 text-2xl font-semibold break-words text-text glow-accent sm:text-3xl"
            data-testid="overview-totals"
          >
            {overview.invoicedTotals.length === 0
              ? "—"
              : overview.invoicedTotals.map((x) => (
                  // One currency per line: amounts are never added across currencies.
                  <span key={x.currency} className="block" data-currency={x.currency}>
                    {formatMoney(x.amount, x.currency, locale)}
                  </span>
                ))}
          </dd>
        </div>
      </dl>
      {/* Drafts vs issued at a glance. Decorative: the same counts are in the figures above. An SVG
          (not an inline style width) so a future strict CSP needs no style exception. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 100 4"
        preserveAspectRatio="none"
        className="block h-1.5 w-full overflow-visible"
        data-testid="overview-share"
        data-share={share}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--color-accent-strong)" />
            <stop offset="1" stopColor="var(--color-accent)" />
          </linearGradient>
        </defs>
        <rect width="100" height="4" rx="2" fill="var(--color-surface-2)" />
        {share > 0 ? <rect width={share} height="4" rx="2" fill={`url(#${gradientId})`} /> : null}
      </svg>
    </div>
  );
}
