import { getTranslations } from "next-intl/server";
import { Brand } from "@/components/layout/brand";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { ThemeSwitch } from "@/components/layout/theme-switch";
import { Link } from "@/i18n/navigation";

const LINKS = ["features", "pricing", "faq", "about"] as const;

/**
 * Navigation of the public pages. On phones the links sit in a native <details> disclosure, so the
 * menu works without JavaScript and is announced as expandable; the call to action stays visible.
 */
export async function PublicHeader() {
  const t = await getTranslations("public.nav");
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/welcome" aria-label={t("home")} className="shrink-0">
          <Brand />
        </Link>
        <nav aria-label={t("label")} className="ml-6 hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l}
              href={`/${l}`}
              className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              {t(l)}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:block">
            <LocaleSwitcher />
          </div>
          <ThemeSwitch />
          <Link
            href="/sign-in"
            className="hidden rounded-lg px-3 py-2 text-sm text-text hover:text-accent sm:inline-flex"
            data-testid="public-sign-in"
          >
            {t("signIn")}
          </Link>
          <Link
            href="/sign-up"
            className="inline-flex min-h-10 items-center rounded-lg bg-accent-strong px-3.5 text-sm font-medium text-white shadow-[0_0_24px_-6px_var(--color-accent)] transition-transform hover:-translate-y-px"
            data-testid="public-start"
          >
            {t("start")}
          </Link>
          <details className="group relative md:hidden">
            <summary
              className="flex size-10 cursor-pointer list-none items-center justify-center rounded-lg border border-border text-text [&::-webkit-details-marker]:hidden"
              aria-label={t("menu")}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
              </svg>
            </summary>
            <div className="absolute right-0 mt-2 w-60 animate-fade-up space-y-1 rounded-2xl border border-border bg-surface p-2 shadow-2xl">
              {LINKS.map((l) => (
                <Link
                  key={l}
                  href={`/${l}`}
                  className="block rounded-lg px-3 py-2.5 text-sm text-text hover:bg-surface-2"
                >
                  {t(l)}
                </Link>
              ))}
              <Link
                href="/sign-in"
                className="block rounded-lg px-3 py-2.5 text-sm text-text hover:bg-surface-2"
              >
                {t("signIn")}
              </Link>
              <div className="px-3 py-2">
                <LocaleSwitcher />
              </div>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
