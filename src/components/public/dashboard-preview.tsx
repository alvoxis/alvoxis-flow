import { getTranslations } from "next-intl/server";

/** Illustrative bars (relative heights only, no amounts): revenue and expenses for six months. */
const BARS: [number, number][] = [
  [52, 38],
  [61, 41],
  [58, 47],
  [70, 44],
  [76, 49],
  [88, 52],
];

/**
 * A stylised preview of the business overview for the landing page. It shows NO figures that could
 * be mistaken for customer data — only labels and relative shapes — and says so in a visible label.
 * Pure CSS animation (bars grow, line draws), off with reduced motion.
 */
export async function DashboardPreview() {
  const t = await getTranslations("public.preview");
  return (
    <figure
      className="relative overflow-hidden rounded-3xl p-4 surface-raised sm:p-6"
      aria-label={t("aria")}
    >
      <span
        className="absolute top-3 right-3 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-muted"
        data-testid="preview-illustrative"
      >
        {t("label")}
      </span>
      <div className="grid grid-cols-2 gap-3 pt-6 sm:grid-cols-4">
        {(["revenue", "expenses", "result", "receivables"] as const).map((k, i) => (
          <div
            key={k}
            className="animate-fade-up rounded-2xl bg-surface-2/80 p-3"
            style={{ animationDelay: `${150 + i * 90}ms` }}
          >
            <p className="text-xs text-muted">{t(k)}</p>
            <div
              className="mt-2 h-2.5 w-3/4 rounded-full bg-gradient-to-r from-accent to-accent/30"
              aria-hidden="true"
            />
            <div className="mt-1.5 h-1.5 w-1/2 rounded-full bg-border" aria-hidden="true" />
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-2xl bg-surface-2/50 p-3">
        <p className="mb-2 text-xs text-muted">{t("chart")}</p>
        <svg viewBox="0 0 300 110" className="h-auto w-full" aria-hidden="true">
          {[20, 50, 80].map((y) => (
            <line
              key={y}
              x1="0"
              x2="300"
              y1={y}
              y2={y}
              className="stroke-border"
              strokeDasharray="2 4"
            />
          ))}
          {BARS.map(([a, b], i) => {
            const x = 18 + i * 47;
            return (
              <g key={i}>
                <rect
                  x={x}
                  y={100 - a}
                  width="14"
                  height={a}
                  rx="3"
                  fill="var(--color-series-1)"
                  className="chart-grow"
                  style={{ animationDelay: `${400 + i * 70}ms` }}
                />
                <rect
                  x={x + 16}
                  y={100 - b}
                  width="14"
                  height={b}
                  rx="3"
                  fill="var(--color-series-2)"
                  className="chart-grow"
                  style={{ animationDelay: `${440 + i * 70}ms` }}
                />
              </g>
            );
          })}
          <path
            d="M25 70 L72 62 L119 58 L166 45 L213 38 L260 24"
            fill="none"
            stroke="var(--color-text)"
            strokeOpacity="0.5"
            strokeWidth="2"
            strokeLinecap="round"
            pathLength={1}
            className="chart-draw"
            style={{ animationDelay: "700ms" }}
          />
        </svg>
        <div className="mt-2 flex gap-4 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ background: "var(--color-series-1)" }}
            />
            {t("revenue")}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ background: "var(--color-series-2)" }}
            />
            {t("expenses")}
          </span>
        </div>
      </div>
    </figure>
  );
}
