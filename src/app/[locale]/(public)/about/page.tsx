import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { publicMetadata } from "@/components/public/metadata";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return publicMetadata((await params).locale, "about", "/about");
}

/** What the product is and the principles it is built on; no invented company facts. */
export default async function AboutPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("public.about");
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight text-text">{t("title")}</h1>
      <p className="mt-4 text-muted">{t("intro")}</p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {([1, 2, 3, 4] as const).map((n) => (
          <li key={n} className="rounded-2xl p-5 surface-raised">
            <h2 className="font-semibold text-text">{t(`principles.${n}.title`)}</h2>
            <p className="mt-1 text-sm text-muted">{t(`principles.${n}.text`)}</p>
          </li>
        ))}
      </ul>
      <p className="mt-8 rounded-2xl border border-border p-4 text-sm text-muted">{t("status")}</p>
    </div>
  );
}
