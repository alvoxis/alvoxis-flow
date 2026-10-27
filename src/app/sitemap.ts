import { type MetadataRoute } from "next";
import { publicOrigin } from "@/components/public/metadata";
import { LOCALES } from "@/i18n/config";

const PAGES = [
  "/welcome",
  "/features",
  "/pricing",
  "/faq",
  "/about",
  "/contact",
  "/legal/privacy",
  "/legal/terms",
  "/legal/subscription",
  "/legal/cookies",
];

/** Public pages only, in every language; app pages are never listed (and are noindex). */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  return PAGES.flatMap((path) =>
    LOCALES.map((locale) => ({
      url: `${origin}/${locale}${path}`,
      changeFrequency: "monthly" as const,
      priority: path === "/welcome" ? 1 : 0.6,
      alternates: {
        languages: Object.fromEntries(LOCALES.map((l) => [l, `${origin}/${l}${path}`])),
      },
    })),
  );
}
