/**
 * Dashboard periods. Dates are calendar dates (YYYY-MM-DD, inclusive on both ends) in UTC; a
 * custom range must be valid, start before it ends and span at most 3 years. The previous period
 * is the same number of days just before, for comparisons.
 */
export const RANGE_PRESETS = [
  "this_month",
  "last_month",
  "this_quarter",
  "this_year",
  "custom",
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface DateRange {
  preset: RangePreset;
  from: string;
  to: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

function isIsoDate(v: string | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && iso(new Date(t)) === v;
}

export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): DateRange {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const month = m - 1;
  switch (preset) {
    case "this_month":
      return { preset, from: iso(utc(y, month, 1)), to: iso(utc(y, month + 1, 0)) };
    case "last_month":
      return { preset, from: iso(utc(y, month - 1, 1)), to: iso(utc(y, month, 0)) };
    case "this_quarter": {
      const q = Math.floor(month / 3) * 3;
      return { preset, from: iso(utc(y, q, 1)), to: iso(utc(y, q + 3, 0)) };
    }
    case "this_year":
      return { preset, from: `${y}-01-01`, to: `${y}-12-31` };
  }
}

/** The range from URL parameters (`range`, `from`, `to`); anything invalid → this month. */
export function parseRange(
  params: { range?: string; from?: string; to?: string },
  today: string,
): DateRange {
  const preset = RANGE_PRESETS.find((p) => p === params.range) ?? "this_month";
  if (preset !== "custom") return presetRange(preset, today);
  const { from, to } = params;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to || daysIn({ from, to }) > 366 * 3)
    return presetRange("this_month", today);
  return { preset, from, to };
}

export function daysIn(r: { from: string; to: string }): number {
  return (
    Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) +
    1
  );
}

/** The same number of days immediately before `r`. */
export function previousRange(r: { from: string; to: string }): { from: string; to: string } {
  const days = daysIn(r);
  const start = Date.parse(`${r.from}T00:00:00Z`);
  return { from: iso(new Date(start - days * 86_400_000)), to: iso(new Date(start - 86_400_000)) };
}

/** Chart buckets: days for up to 62 days, months beyond. */
export function bucketOf(r: { from: string; to: string }): "day" | "month" {
  return daysIn(r) <= 62 ? "day" : "month";
}

/** Every bucket key of the range in order ("2026-03-05" for days, "2026-03" for months). */
export function bucketKeys(r: { from: string; to: string }): string[] {
  const keys: string[] = [];
  if (bucketOf(r) === "day") {
    for (
      let t = Date.parse(`${r.from}T00:00:00Z`);
      t <= Date.parse(`${r.to}T00:00:00Z`);
      t += 86_400_000
    )
      keys.push(iso(new Date(t)));
    return keys;
  }
  let [y, m] = r.from.split("-").map(Number) as [number, number];
  const [ty, tm] = r.to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return keys;
}
