import { getTranslations } from "next-intl/server";
import { type ReactNode } from "react";
import { SignOutButton } from "@/components/auth/two-factor-forms";
import { Link } from "@/i18n/navigation";
import { Brand } from "./brand";
import { type CompanyChoice, CompanyContext } from "./company-context";
import { LocaleSwitcher } from "./locale-switcher";
import { MobileNav } from "./mobile-nav";
import { NavList } from "./nav-list";

export async function AppShell({
  children,
  user,
  companies,
}: {
  children: ReactNode;
  user: { email: string; displayName: string | null };
  /** The user's companies, for the company shown in the top bar. */
  companies: readonly CompanyChoice[];
}) {
  const t = await getTranslations();

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface/60 p-4 lg:flex">
        <div className="mb-8 px-1">
          <Brand />
        </div>
        <nav aria-label={t("nav.main")} className="flex-1 overflow-y-auto">
          <NavList />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-bg/85 px-4 py-3 backdrop-blur sm:px-6">
          <MobileNav />
          {/* The mobile drawer shows the brand; on phones the bar keeps only essentials. */}
          {/* Never shrinks: the company name gives way (ellipsis) instead of covering the brand. */}
          <div className="hidden shrink-0 sm:block lg:hidden" data-testid="topbar-brand">
            <Brand />
          </div>
          <CompanyContext companies={companies} />
          <div className="ml-auto flex shrink-0 items-center gap-3" data-testid="topbar-actions">
            <LocaleSwitcher />
            <div className="flex items-center gap-2 text-sm text-muted" title={t("topbar.account")}>
              <Link
                href="/account/security"
                className="flex items-center gap-2 rounded-lg px-1 py-1 hover:text-text"
                data-testid="account-menu"
              >
                <span
                  className="inline-flex size-8 items-center justify-center rounded-full bg-accent-soft text-violet-200 uppercase"
                  aria-hidden="true"
                >
                  {(user.displayName ?? user.email).slice(0, 1)}
                </span>
                <span className="hidden max-w-48 truncate xl:inline">{user.email}</span>
                <span className="sr-only">{t("account.security")}</span>
              </Link>
              <SignOutButton label={t("account.signOut")} className="px-2" />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
