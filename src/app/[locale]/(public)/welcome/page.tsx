import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DashboardPreview } from "@/components/public/dashboard-preview";
import { FaqList } from "@/components/public/faq-list";
import { publicMetadata } from "@/components/public/metadata";
import { PricingCard } from "@/components/public/pricing-card";
import { Link } from "@/i18n/navigation";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return publicMetadata((await params).locale, "welcome", "/welcome");
}

const FEATURES = [
  "dashboard",
  "documents",
  "finance",
  "catalog",
  "costing",
  "production",
  "ai",
  "team",
] as const;
const ICONS: Record<(typeof FEATURES)[number], string> = {
  dashboard: "M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6Zm10-18v6h8V3h-8Z",
  documents: "M7 3h7l5 5v13H7V3Zm7 0v5h5M9 13h8M9 17h6",
  finance: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  catalog: "M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8",
  costing: "M5 3h14v18H5V3Zm3 3h8v3H8V6Zm0 6h2m3 0h2m-7 3h2m3 0h2",
  production: "M3 21V10l6 4V10l6 4V4h6v17H3Z",
  ai: "M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z",
  team: "M16 20v-2a4 4 0 0 0-8 0v2M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
};

/** The public landing page. Copy makes no claims about customers, results or certifications. */
export default async function WelcomePage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("public");
  return (
    <div className="overflow-x-clip" data-testid="landing">
      <section className="relative isolate">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-24 -z-10 h-[34rem] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--color-accent-strong)_30%,transparent),transparent_65%)]"
        />
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
          <div className="space-y-6">
            <p className="inline-flex animate-fade-up rounded-full border border-accent/40 bg-accent-soft/60 px-3 py-1 text-xs font-medium text-text">
              {t("hero.eyebrow")}
            </p>
            <h1
              className="animate-fade-up text-4xl font-semibold tracking-tight text-balance text-text sm:text-5xl"
              style={{ animationDelay: "80ms" }}
            >
              {t("hero.title")}
            </h1>
            <p
              className="max-w-xl animate-fade-up text-lg text-muted"
              style={{ animationDelay: "160ms" }}
            >
              {t("hero.subtitle")}
            </p>
            <div
              className="flex animate-fade-up flex-wrap gap-3"
              style={{ animationDelay: "240ms" }}
            >
              <Link
                href="/sign-up"
                className="inline-flex min-h-12 items-center rounded-xl bg-accent-strong px-5 font-medium text-white shadow-[0_0_32px_-8px_var(--color-accent)] transition-transform hover:-translate-y-0.5"
                data-testid="hero-start"
              >
                {t("hero.primary")}
              </Link>
              <Link
                href="/features"
                className="inline-flex min-h-12 items-center rounded-xl border border-border px-5 font-medium text-text transition-colors hover:border-accent/60"
              >
                {t("hero.secondary")}
              </Link>
            </div>
            <p className="text-sm text-muted">{t("hero.note")}</p>
          </div>
          <div className="animate-fade-up" style={{ animationDelay: "200ms" }}>
            <DashboardPreview />
          </div>
        </div>
      </section>

      <section aria-labelledby="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="features" className="text-3xl font-semibold tracking-tight text-text">
          {t("features.title")}
        </h2>
        <p className="mt-2 max-w-2xl text-muted">{t("features.subtitle")}</p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <li
              key={f}
              className="animate-fade-up rounded-2xl p-5 surface-raised transition-transform hover:-translate-y-1"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-6 text-accent"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.7}
                strokeLinejoin="round"
              >
                <path d={ICONS[f]} />
              </svg>
              <h3 className="mt-3 font-semibold text-text">{t(`features.items.${f}.title`)}</h3>
              <p className="mt-1 text-sm text-muted">{t(`features.items.${f}.text`)}</p>
            </li>
          ))}
        </ul>
      </section>

      {(["costing", "invoices", "ai"] as const).map((block, i) => (
        <section
          key={block}
          aria-labelledby={`block-${block}`}
          className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-12 sm:px-6 lg:grid-cols-2"
        >
          <div className={i % 2 ? "lg:order-2" : ""}>
            <h2
              id={`block-${block}`}
              className="text-2xl font-semibold tracking-tight text-text sm:text-3xl"
            >
              {t(`${block}.title`)}
            </h2>
            <p className="mt-3 text-muted">{t(`${block}.text`)}</p>
          </div>
          <ul className="space-y-3">
            {([1, 2, 3, 4] as const).map((n) => (
              <li
                key={n}
                className="flex gap-3 rounded-2xl border border-border bg-surface/60 p-4 text-sm text-text"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="mt-0.5 size-4 shrink-0 text-accent"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path d="m5 12 5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t(`${block}.points.${n}`)}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="countries" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="rounded-3xl p-6 surface-raised sm:p-8">
          <h2 id="countries" className="text-2xl font-semibold tracking-tight text-text">
            {t("countries.title")}
          </h2>
          <p className="mt-2 max-w-2xl text-muted">{t("countries.text")}</p>
          <ul className="mt-5 flex flex-wrap gap-2">
            {(["LV", "LT", "EE", "PL"] as const).map((c) => (
              <li
                key={c}
                className="rounded-full border border-border px-3 py-1.5 text-sm text-text"
              >
                {t(`countries.list.${c}`)}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted">{t("countries.languages")}</p>
        </div>
      </section>

      <section aria-labelledby="pricing" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="pricing" className="text-center text-3xl font-semibold tracking-tight text-text">
          {t("pricing.title")}
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-muted">{t("pricing.subtitle")}</p>
        <div className="mx-auto mt-8 max-w-xl">
          <PricingCard />
        </div>
      </section>

      <section aria-labelledby="faq" className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h2 id="faq" className="text-3xl font-semibold tracking-tight text-text">
          {t("faq.title")}
        </h2>
        <div className="mt-6">
          <FaqList limit={6} />
        </div>
        <Link href="/faq" className="mt-4 inline-block text-sm text-accent hover:underline">
          {t("faq.more")}
        </Link>
      </section>

      <section className="mx-auto max-w-6xl px-4 pt-6 pb-20 sm:px-6">
        <div className="relative isolate overflow-hidden rounded-3xl border border-accent/30 bg-accent-soft/40 p-8 text-center sm:p-12">
          <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">
            {t("cta.title")}
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-muted">{t("cta.text")}</p>
          <Link
            href="/sign-up"
            className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-accent-strong px-6 font-medium text-white transition-transform hover:-translate-y-0.5"
          >
            {t("cta.button")}
          </Link>
        </div>
      </section>
    </div>
  );
}
