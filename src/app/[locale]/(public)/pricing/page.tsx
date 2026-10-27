import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { publicMetadata } from "@/components/public/metadata";
import { PricingCard } from "@/components/public/pricing-card";
import { Link } from "@/i18n/navigation";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return publicMetadata((await params).locale, "pricing", "/pricing");
}

/** One plan, one price. Terms in short, with a link to the full subscription terms. */
export default async function PricingPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("public.pricing");
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6" data-testid="pricing-page">
      <h1 className="text-center text-4xl font-semibold tracking-tight text-text">{t("title")}</h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted">{t("subtitle")}</p>
      <div className="mt-10">
        <PricingCard />
      </div>
      <section className="mt-10 space-y-3 text-sm text-muted" aria-labelledby="pricing-details">
        <h2 id="pricing-details" className="text-lg font-semibold text-text">
          {t("detailsTitle")}
        </h2>
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <p key={n}>{t(`details.${n}`)}</p>
        ))}
        <Link href="/legal/subscription" className="inline-block text-accent hover:underline">
          {t("termsLink")}
        </Link>
      </section>
    </div>
  );
}
