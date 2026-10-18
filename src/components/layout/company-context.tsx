"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export interface CompanyChoice {
  id: string;
  name: string;
}

/**
 * The company the user is working in, in the top bar: the company of the current page (any
 * `/companies/{id}/…` route), otherwise the only company. With several companies and no company
 * page open it shows nothing; with none it says so. Names come from the user's own memberships.
 */
export function CompanyContext({ companies }: { companies: readonly CompanyChoice[] }) {
  const t = useTranslations("topbar");
  const pathname = usePathname();
  const fromPath = /^\/companies\/([^/]+)/.exec(pathname)?.[1];
  const current =
    companies.find((c) => c.id === fromPath) ?? (companies.length === 1 ? companies[0] : undefined);
  const chip =
    "hidden min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm sm:flex";

  if (companies.length === 0)
    return (
      <div className={`${chip} text-muted`} data-testid="topbar-company" data-state="none">
        <span className="size-2 shrink-0 rounded-full bg-muted/50" aria-hidden="true" />
        <span className="truncate">{t("noCompany")}</span>
      </div>
    );
  if (!current) return null;
  return (
    <Link
      href={`/companies/${current.id}/documents`}
      className={`${chip} max-w-64 text-text hover:border-accent/60`}
      data-testid="topbar-company"
      data-state="current"
    >
      <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
      <span className="sr-only">{t("currentCompany")}: </span>
      <span className="truncate">{current.name}</span>
    </Link>
  );
}
