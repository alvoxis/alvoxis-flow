"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Link } from "@/i18n/navigation";

interface MonthSales {
  month: number;
  currency: string;
  net: string;
  invoices: number;
  creditNotes: number;
}

export interface AnalyticsData {
  year: number;
  years: number[];
  months: MonthSales[];
  customers: {
    name: string;
    registrationNumber: string | null;
    currency: string;
    net: string;
    documents: number;
  }[];
  items: {
    description: string;
    unit: string | null;
    currency: string;
    quantity: string;
    net: string;
  }[];
  stock: { currency: string; value: string }[] | null;
  payroll: { currency: string; employerCost: string; months: number }[] | null;
  production: { completed: number; planned: number } | null;
}

const cents = (v: string) => {
  const neg = v.startsWith("-");
  const [i = "0", f = ""] = v.replace("-", "").split(".");
  const c = BigInt(i) * 100n + BigInt((f + "00").slice(0, 2));
  return neg ? -c : c;
};
const fmt = (c: bigint) => {
  const a = c < 0n ? -c : c;
  return `${c < 0n ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
};

/**
 * Analytics for one year: sales per currency (hero total + monthly bars with hover details and a
 * table view), best customers and lines, and stock, payroll and production figures when the role
 * may see them. Currencies are never mixed or converted.
 */
export function AnalyticsView({ companyId, data }: { companyId: string; data: AnalyticsData }) {
  const t = useTranslations("analytics");
  const currencies = [...new Set(data.months.map((m) => m.currency))];

  return (
    <div className="space-y-8" data-testid="analytics-view">
      <nav aria-label={t("year")} className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">{t("year")}:</span>
        {data.years.map((y) => (
          <Link
            key={y}
            href={`/companies/${companyId}/analytics?year=${y}`}
            aria-current={y === data.year ? "page" : undefined}
            className={
              y === data.year
                ? "rounded-lg bg-accent-soft px-3 py-1.5 text-sm font-medium text-violet-100"
                : "rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-text"
            }
          >
            {y}
          </Link>
        ))}
      </nav>

      {currencies.length === 0 ? (
        <p className="text-sm text-muted" data-testid="analytics-empty">
          {t("noSales", { year: data.year })}
        </p>
      ) : (
        currencies.map((cur) => (
          <SalesChart
            key={cur}
            currency={cur}
            months={data.months.filter((m) => m.currency === cur)}
          />
        ))
      )}

      {data.stock || data.payroll || data.production ? (
        <section className="grid gap-3 sm:grid-cols-3" aria-label={t("other.title")}>
          {data.stock ? (
            <Tile
              label={t("other.stock")}
              values={data.stock.length ? data.stock.map((s) => `${s.value} ${s.currency}`) : ["—"]}
              testId="tile-stock"
            />
          ) : null}
          {data.payroll ? (
            <Tile
              label={t("other.payroll", { year: data.year })}
              values={
                data.payroll.length
                  ? data.payroll.map((p) => `${p.employerCost} ${p.currency}`)
                  : ["—"]
              }
              testId="tile-payroll"
            />
          ) : null}
          {data.production ? (
            <Tile
              label={t("other.production", { year: data.year })}
              values={[
                t("other.productionValue", {
                  completed: data.production.completed,
                  planned: data.production.planned,
                }),
              ]}
              testId="tile-production"
            />
          ) : null}
        </section>
      ) : null}

      <section className="space-y-2" aria-labelledby="top-customers">
        <h3 id="top-customers" className="text-sm font-semibold text-text">
          {t("customers.title")}
        </h3>
        {data.customers.length ? (
          <Table
            testId="top-customers"
            head={[t("customers.name"), t("customers.documents"), t("net")]}
            rows={data.customers.map((c) => [
              <span key="n" className="break-words">
                {c.name}
                {c.registrationNumber ? (
                  <span className="block text-xs text-muted">{c.registrationNumber}</span>
                ) : null}
              </span>,
              String(c.documents),
              `${c.net} ${c.currency}`,
            ])}
          />
        ) : (
          <p className="text-sm text-muted">{t("none")}</p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="top-items">
        <h3 id="top-items" className="text-sm font-semibold text-text">
          {t("items.title")}
        </h3>
        {data.items.length ? (
          <Table
            testId="top-items"
            head={[t("items.description"), t("items.quantity"), t("net")]}
            rows={data.items.map((i) => [
              <span key="d" className="break-words">
                {i.description}
              </span>,
              `${i.quantity}${i.unit ? ` ${i.unit}` : ""}`,
              `${i.net} ${i.currency}`,
            ])}
          />
        ) : (
          <p className="text-sm text-muted">{t("none")}</p>
        )}
      </section>
    </div>
  );
}

function Tile({ label, values, testId }: { label: string; values: string[]; testId: string }) {
  return (
    <div className="rounded-xl border border-border p-3" data-testid={testId}>
      <p className="text-xs text-muted">{label}</p>
      {values.map((v) => (
        <p key={v} className="text-lg font-semibold whitespace-nowrap text-text tabular-nums">
          {v}
        </p>
      ))}
    </div>
  );
}

function Table({
  head,
  rows,
  testId,
}: {
  head: string[];
  rows: (string | React.ReactNode)[][];
  testId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={h} className={`py-2 font-medium ${i > 0 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60">
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`py-2 align-top text-text ${j > 0 ? "pl-3 text-right whitespace-nowrap tabular-nums" : "min-w-0"}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const W = 600;
const H = 180;
const PAD_TOP = 8;

/**
 * Monthly net sales of one currency: 12 thin bars with rounded tops anchored to the baseline (a
 * zero line when a month is negative), recessive grid, a hover/focus readout and a table view.
 * One series, so the title names it and there is no legend.
 */
function SalesChart({ currency, months }: { currency: string; months: MonthSales[] }) {
  const t = useTranslations("analytics");
  const [active, setActive] = useState<number | null>(null);
  const byMonth = Array.from({ length: 12 }, (_, i) => months.find((m) => m.month === i + 1));
  const values = byMonth.map((m) => (m ? cents(m.net) : 0n));
  const total = values.reduce((a, b) => a + b, 0n);
  const maxV = values.reduce((a, b) => (b > a ? b : a), 0n);
  const minV = values.reduce((a, b) => (b < a ? b : a), 0n);
  const span = Number(maxV - minV) || 1;
  const y = (v: bigint) => PAD_TOP + (Number(maxV - v) / span) * (H - PAD_TOP - 4);
  const zero = y(0n);
  const slot = W / 12;
  const barW = Math.round(slot * 0.6);
  const label = (i: number) => t(`month.${i + 1}` as Parameters<typeof t>[0]);
  const shown = active ?? null;

  return (
    <section
      className="space-y-3"
      aria-labelledby={`sales-${currency}`}
      data-testid="sales-chart"
      data-currency={currency}
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id={`sales-${currency}`} className="text-sm font-semibold text-text">
            {t("sales.title", { currency })}
          </h3>
          <p
            className="text-2xl font-semibold whitespace-nowrap text-text tabular-nums"
            data-testid="sales-total"
          >
            {fmt(total)} {currency}
          </p>
        </div>
        <p
          className="min-h-5 text-sm text-muted tabular-nums"
          aria-live="polite"
          data-testid="sales-readout"
        >
          {shown !== null
            ? `${label(shown)}: ${fmt(values[shown]!)} ${currency} · ${t("sales.counts", {
                invoices: byMonth[shown]?.invoices ?? 0,
                creditNotes: byMonth[shown]?.creditNotes ?? 0,
              })}`
            : t("sales.hint")}
        </p>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={t("sales.aria", { currency, total: fmt(total) })}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={PAD_TOP + f * (H - PAD_TOP - 4)}
            y2={PAD_TOP + f * (H - PAD_TOP - 4)}
            stroke="var(--color-border)"
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}
        <line x1={0} x2={W} y1={zero} y2={zero} stroke="var(--color-muted)" strokeWidth={1} />
        {values.map((v, i) => {
          const top = Math.min(y(v), zero);
          const h = Math.max(Math.abs(zero - y(v)), v === 0n ? 0 : 2);
          const x = i * slot + (slot - barW) / 2;
          const r = Math.min(4, h / 2, barW / 2);
          // Rounded only at the data end (away from the baseline).
          const d =
            v >= 0n
              ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`
              : `M${x},${top} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + barW - r} Q${x + barW},${top + h} ${x + barW},${top + h - r} V${top} Z`;
          return (
            <g key={i}>
              {h > 0 ? (
                <path
                  d={d}
                  fill="var(--color-accent)"
                  opacity={active === null || active === i ? 1 : 0.45}
                />
              ) : null}
              {/* Hit target: the whole month column, larger than the bar. */}
              <rect
                x={i * slot}
                y={0}
                width={slot}
                height={H}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${label(i)}: ${fmt(v)} ${currency}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onClick={() => setActive(active === i ? null : i)}
              />
            </g>
          );
        })}
      </svg>
      {/* Month labels in HTML so they stay readable when the chart scales down. */}
      <div
        className="grid grid-cols-12 text-center text-[11px] text-muted sm:text-xs"
        aria-hidden="true"
      >
        {values.map((_, i) => (
          <span key={i}>{t(`monthShort.${i + 1}` as Parameters<typeof t>[0])}</span>
        ))}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-violet-300">{t("sales.table")}</summary>
        <Table
          testId="sales-table"
          head={[t("sales.month"), t("sales.invoices"), t("sales.creditNotes"), t("net")]}
          rows={byMonth.map((m, i) => [
            label(i),
            String(m?.invoices ?? 0),
            String(m?.creditNotes ?? 0),
            `${fmt(values[i]!)} ${currency}`,
          ])}
        />
      </details>
    </section>
  );
}
