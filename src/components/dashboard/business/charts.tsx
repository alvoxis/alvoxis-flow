"use client";

import { type PointerEvent, useId, useMemo, useState } from "react";

/**
 * Small SVG charts for the business dashboard. One y-axis each, thin marks with 4px rounded data
 * ends on the baseline, a 2px gap between neighbouring bars, recessive grid, a hover/focus tooltip
 * (values lead, labels follow) and a table view so nothing depends on hovering or on colour.
 * Colours come from the --color-series-* tokens (validated for CVD on both themes). Bars grow and
 * lines draw once on mount; prefers-reduced-motion turns that off globally.
 */

export interface PairPoint {
  label: string;
  a: number;
  b: number;
  aText: string;
  bText: string;
}

export interface AxisFormat {
  locale: string;
  currency: string;
}

function useAxis({ locale, currency }: AxisFormat) {
  return useMemo(() => {
    const nf = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    });
    return (v: number) => nf.format(v);
  }, [locale, currency]);
}

const W = 640;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 56 };

/** Round "nice" upper bound for an axis. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** A bar whose top corners are rounded (radius ≤ 4) and whose base sits flat on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function Legend({ items }: { items: { label: string; color: string; kind: "bar" | "line" }[] }) {
  return (
    <ul className="flex flex-wrap gap-4 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={
              i.kind === "bar"
                ? "inline-block size-2.5 rounded-sm"
                : "inline-block h-0.5 w-3.5 rounded"
            }
            style={{ background: i.color }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function Tooltip({
  x,
  title,
  rows,
}: {
  x: number;
  title: string;
  rows: { label: string; value: string; color: string }[];
}) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-1 z-10 min-w-36 -translate-x-1/2 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
      style={{ left: `${Math.min(88, Math.max(12, (x / W) * 100))}%` }}
    >
      <p className="mb-1 text-muted">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: r.color }}
          />
          <span className="font-semibold text-text tabular-nums">{r.value}</span>
          <span className="text-muted">{r.label}</span>
        </p>
      ))}
    </div>
  );
}

function TableView({
  caption,
  head,
  rows,
  label,
}: {
  caption: string;
  head: string[];
  rows: string[][];
  label: string;
}) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted hover:text-text">{label}</summary>
      {/* Focusable so keyboard users can scroll it (WCAG 2.1.1). */}
      <div
        className="mt-2 max-h-64 overflow-auto rounded-lg border border-border"
        tabIndex={0}
        role="region"
        aria-label={caption}
      >
        <table className="w-full text-left tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-surface-2 text-muted">
            <tr>
              {head.map((h) => (
                <th key={h} scope="col" className="px-3 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[0]} className="border-t border-border">
                {r.map((c, i) => (
                  <td key={i} className="px-3 py-1.5 text-text">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Two series per bucket as neighbouring bars (e.g. revenue and expenses). */
export function BarPairChart({
  title,
  points,
  aLabel,
  bLabel,
  axisFormat,
  tableLabel,
  bucketLabel,
}: {
  title: string;
  points: PairPoint[];
  aLabel: string;
  bLabel: string;
  /** Locale and currency of the compact axis labels. */
  axisFormat: AxisFormat;
  tableLabel: string;
  bucketLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const axis = useAxis(axisFormat);
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.a, p.b)), 0));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(points.length, 1);
  const barW = Math.max(1.5, Math.min(18, (slot - 6) / 2));
  const y = (v: number) => PAD.top + innerH - (Math.max(v, 0) / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(points.length / 8);

  return (
    <figure className="space-y-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption id={titleId} className="text-sm font-semibold text-text">
          {title}
        </figcaption>
        <Legend
          items={[
            { label: aLabel, color: "var(--color-series-1)", kind: "bar" },
            { label: bLabel, color: "var(--color-series-2)", kind: "bar" },
          ]}
        />
      </div>
      <div className="relative" onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={title}>
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray={v === 0 ? undefined : "2 4"}
              />
              <text
                x={PAD.left - 8}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted text-[10px]"
              >
                {axis(v)}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const x0 = PAD.left + i * slot + (slot - (barW * 2 + 2)) / 2;
            return (
              <g
                key={p.label}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={`${p.label}: ${aLabel} ${p.aText}, ${bLabel} ${p.bText}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              >
                <rect
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={innerH}
                  fill={hover === i ? "var(--color-surface-2)" : "transparent"}
                />
                <path
                  d={barPath(x0, y(p.a), barW, PAD.top + innerH - y(p.a))}
                  fill="var(--color-series-1)"
                  className="chart-grow"
                  style={{ animationDelay: `${Math.min(i, 30) * 15}ms` }}
                />
                <path
                  d={barPath(x0 + barW + 2, y(p.b), barW, PAD.top + innerH - y(p.b))}
                  fill="var(--color-series-2)"
                  className="chart-grow"
                  style={{ animationDelay: `${Math.min(i, 30) * 15 + 40}ms` }}
                />
                {i % labelEvery === 0 ? (
                  <text
                    x={PAD.left + i * slot + slot / 2}
                    y={H - 8}
                    textAnchor="middle"
                    className="fill-muted text-[10px]"
                  >
                    {p.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {hover !== null && points[hover] ? (
          <Tooltip
            x={PAD.left + hover * slot + slot / 2}
            title={points[hover]!.label}
            rows={[
              { label: aLabel, value: points[hover]!.aText, color: "var(--color-series-1)" },
              { label: bLabel, value: points[hover]!.bText, color: "var(--color-series-2)" },
            ]}
          />
        ) : null}
      </div>
      <TableView
        label={tableLabel}
        caption={title}
        head={[bucketLabel, aLabel, bLabel]}
        rows={points.map((p) => [p.label, p.aText, p.bText])}
      />
    </figure>
  );
}

export interface LinePoint {
  label: string;
  value: number;
  text: string;
}

/** One series over time (e.g. cumulative net cash), with a zero line and a crosshair. */
export function LineChart({
  title,
  points,
  seriesLabel,
  axisFormat,
  tableLabel,
  bucketLabel,
}: {
  title: string;
  points: LinePoint[];
  seriesLabel: string;
  axisFormat: AxisFormat;
  tableLabel: string;
  bucketLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const axis = useAxis(axisFormat);
  const values = points.map((p) => p.value);
  const hi = niceMax(Math.max(...values, 0));
  const lo = -niceMax(Math.max(...values.map((v) => -v), 0));
  const min = Math.min(lo, 0) === 0 ? 0 : lo;
  const max = Math.max(hi, min + 1);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;
  const d = useMemo(
    () =>
      points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, min, max],
  );
  const ticks = [0, 0.5, 1].map((f) => min + f * (max - min));
  const labelEvery = Math.ceil(points.length / 8);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / innerW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  return (
    <figure className="space-y-2" aria-labelledby={titleId}>
      <figcaption id={titleId} className="text-sm font-semibold text-text">
        {title}
      </figcaption>
      <div className="relative" onPointerLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-pan-y"
          role="img"
          aria-label={title}
          tabIndex={0}
          onPointerMove={onMove}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1));
            if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? points.length) - 1));
          }}
          onBlur={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              <text
                x={PAD.left - 8}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted text-[10px]"
              >
                {axis(v)}
              </text>
            </g>
          ))}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(0)}
            y2={y(0)}
            className="stroke-muted"
            strokeWidth={1}
          />
          <path
            d={d}
            fill="none"
            stroke="var(--color-series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
            className="chart-draw"
          />
          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text
                key={p.label}
                x={x(i)}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted text-[10px]"
              >
                {p.label}
              </text>
            ) : null,
          )}
          {hover !== null && points[hover] ? (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                className="stroke-muted"
                strokeWidth={1}
              />
              <circle
                cx={x(hover)}
                cy={y(points[hover]!.value)}
                r={4}
                fill="var(--color-series-1)"
                stroke="var(--color-surface)"
                strokeWidth={2}
              />
            </g>
          ) : null}
        </svg>
        {hover !== null && points[hover] ? (
          <Tooltip
            x={x(hover)}
            title={points[hover]!.label}
            rows={[
              { label: seriesLabel, value: points[hover]!.text, color: "var(--color-series-1)" },
            ]}
          />
        ) : null}
      </div>
      <TableView
        label={tableLabel}
        caption={title}
        head={[bucketLabel, seriesLabel]}
        rows={points.map((p) => [p.label, p.text])}
      />
    </figure>
  );
}

/** Magnitudes of a few categories, largest first, with direct labels (one hue). */
export function CategoryBars({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: number; text: string }[];
}) {
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-semibold text-text">{title}</figcaption>
      <ul className="space-y-2">
        {items.map((i, n) => (
          <li
            key={i.label}
            className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-xs"
          >
            <span className="truncate text-muted" title={i.label}>
              {i.label}
            </span>
            <span className="h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
              <span
                className="chart-grow-x block h-full rounded-full"
                style={{
                  width: `${(i.value / max) * 100}%`,
                  background: "var(--color-series-2)",
                  animationDelay: `${n * 50}ms`,
                }}
              />
            </span>
            <span className="font-medium text-text tabular-nums">{i.text}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
