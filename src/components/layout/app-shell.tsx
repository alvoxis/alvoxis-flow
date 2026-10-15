import { getTranslations } from "next-intl/server";
import { type ReactNode } from "react";
import { Brand } from "./brand";
import { LocaleSwitcher } from "./locale-switcher";
import { MobileNav } from "./mobile-nav";
import { NavList } from "./nav-list";

export async function AppShell({ children }: { children: ReactNode }) {
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
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="hidden min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted sm:flex">
            <span className="size-2 rounded-full bg-muted/50" aria-hidden="true" />
            <span className="truncate">{t("topbar.noCompany")}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <LocaleSwitcher />
            <div
              className="hidden items-center gap-2 text-sm text-muted md:flex"
              title={t("topbar.account")}
            >
              <span
                className="inline-flex size-8 items-center justify-center rounded-full bg-accent-soft text-violet-200"
                aria-hidden="true"
              >
                ?
              </span>
              <span>{t("topbar.notSignedIn")}</span>
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
