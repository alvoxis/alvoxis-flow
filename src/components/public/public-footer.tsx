import { getTranslations } from "next-intl/server";
import { Brand } from "@/components/layout/brand";
import { Link } from "@/i18n/navigation";

/** Footer of the public pages: product, legal and contact links. No invented company details. */
export async function PublicFooter() {
  const t = await getTranslations("public.footer");
  const tn = await getTranslations("public.nav");
  return (
    <footer className="border-t border-border/70">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="space-y-3">
          <Brand />
          <p className="max-w-xs text-sm text-muted">{t("tagline")}</p>
        </div>
        <nav aria-label={t("product")} className="space-y-2 text-sm">
          <p className="font-medium text-text">{t("product")}</p>
          {(["features", "pricing", "faq", "about", "contact"] as const).map((l) => (
            <Link key={l} href={`/${l}`} className="block text-muted hover:text-text">
              {tn(l)}
            </Link>
          ))}
        </nav>
        <nav aria-label={t("legal")} className="space-y-2 text-sm">
          <p className="font-medium text-text">{t("legal")}</p>
          {(["privacy", "terms", "subscription", "cookies"] as const).map((l) => (
            <Link key={l} href={`/legal/${l}`} className="block text-muted hover:text-text">
              {t(`links.${l}`)}
            </Link>
          ))}
        </nav>
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text">{t("account")}</p>
          <Link href="/sign-in" className="block text-muted hover:text-text">
            {tn("signIn")}
          </Link>
          <Link href="/sign-up" className="block text-muted hover:text-text">
            {tn("start")}
          </Link>
        </div>
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted sm:px-6">{t("note")}</p>
    </footer>
  );
}
