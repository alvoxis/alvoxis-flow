import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { publicMetadata } from "@/components/public/metadata";
import { Link } from "@/i18n/navigation";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return publicMetadata((await params).locale, "features", "/features");
}

const MODULES = [
  "dashboard",
  "documents",
  "finance",
  "catalog",
  "costing",
  "production",
  "ai",
  "team",
] as const;

/** What each module does, in plain terms, including its limits. */
export default async function FeaturesPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("public");
  return (
    <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight text-text">{t("featuresPage.title")}</h1>
      <p className="mt-3 max-w-2xl text-muted">{t("featuresPage.intro")}</p>
      <div className="mt-10 grid gap-5 md:grid-cols-2">
        {MODULES.map((m, i) => (
          <section
            key={m}
            className="animate-fade-up rounded-2xl p-6 surface-raised"
            style={{ animationDelay: `${i * 40}ms` }}
            aria-labelledby={`m-${m}`}
          >
            <h2 id={`m-${m}`} className="text-lg font-semibold text-text">
              {t(`features.items.${m}.title`)}
            </h2>
            <p className="mt-2 text-sm text-muted">{t(`featuresPage.details.${m}`)}</p>
          </section>
        ))}
      </div>
      <p className="mt-10 text-sm text-muted">{t("featuresPage.limits")}</p>
      <Link
        href="/sign-up"
        className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-accent-strong px-5 font-medium text-white"
      >
        {t("hero.primary")}
      </Link>
    </div>
  );
}
