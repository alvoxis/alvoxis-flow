import { type Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type AppLocale, LOCALES } from "@/i18n/config";

export type PublicPage =
  | "welcome"
  | "features"
  | "pricing"
  | "about"
  | "contact"
  | "faq"
  | "privacy"
  | "terms"
  | "subscription"
  | "cookies";

/** The public origin for canonical URLs (not a secret; falls back to the local dev server). */
export function publicOrigin(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

/** Title, description, canonical URL and language alternates of a public page. */
export async function publicMetadata(
  locale: AppLocale,
  page: PublicPage,
  path: string,
): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "public.meta" });
  const origin = publicOrigin();
  return {
    title: t(`${page}.title`),
    description: t(`${page}.description`),
    alternates: {
      canonical: `${origin}/${locale}${path}`,
      languages: Object.fromEntries(LOCALES.map((l) => [l, `${origin}/${l}${path}`])),
    },
    openGraph: {
      title: t(`${page}.title`),
      description: t(`${page}.description`),
      url: `${origin}/${locale}${path}`,
      siteName: "ALVOXIS Flow",
      type: "website",
      locale,
    },
    robots: { index: true, follow: true },
  };
}
