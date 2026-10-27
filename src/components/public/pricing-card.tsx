import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PLAN } from "@/modules/billing/plans";

const FEATURES = [
  "dashboard",
  "documents",
  "finance",
  "catalog",
  "costing",
  "ai",
  "team",
  "languages",
] as const;

/** The one plan, from the central plan configuration (never a hard-coded price elsewhere). */
export async function PricingCard() {
  const t = await getTranslations("billing");
  const tf = await getTranslations("pricing.features");
  const tp = await getTranslations("public.pricing");
  return (
    <div
      className="relative overflow-hidden rounded-3xl p-6 surface-raised sm:p-8"
      data-testid="pricing-card"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-accent)_35%,transparent),transparent)]"
      />
      <p className="text-sm font-medium text-accent">{tp("only")}</p>
      <p className="mt-1 text-xl font-semibold text-text">{t("planName")}</p>
      <p className="mt-4 flex items-end gap-1 text-text">
        <span
          className="text-5xl font-semibold tracking-tight tabular-nums glow-accent"
          data-testid="pricing-amount"
        >
          €{PLAN.priceEur}
        </span>
        <span className="pb-1.5 text-muted">{t("perMonth")}</span>
      </p>
      <p className="mt-1 text-sm text-muted">{tp("perCompany")}</p>
      <ul className="mt-6 grid gap-2 text-sm text-text sm:grid-cols-2">
        {FEATURES.map((f) => (
          <li key={f} className="flex gap-2">
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
            {tf(f)}
          </li>
        ))}
      </ul>
      <Link
        href="/sign-up"
        className="mt-7 flex min-h-12 items-center justify-center rounded-xl bg-accent-strong font-medium text-white transition-transform hover:-translate-y-0.5"
        data-testid="pricing-start"
      >
        {tp("cta")}
      </Link>
      <ul className="mt-5 space-y-1 text-xs text-muted">
        {([1, 2, 3, 4] as const).map((n) => (
          <li key={n}>{tp(`terms.${n}`)}</li>
        ))}
      </ul>
    </div>
  );
}
