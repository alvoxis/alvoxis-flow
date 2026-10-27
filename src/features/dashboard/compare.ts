import Decimal from "decimal.js";

/**
 * Change of a figure against the previous period, in percent with one decimal ("+12.5"), or null
 * when there is nothing to compare with (previous value zero). Relative to the previous value's
 * magnitude, so a loss shrinking from −100 to −50 reads as +50 %.
 */
export function percentChange(current: string, previous: string): string | null {
  const prev = new Decimal(previous);
  if (prev.isZero()) return null;
  const change = new Decimal(current).minus(prev).div(prev.abs()).times(100);
  const fixed = change.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
  return change.isPositive() && !change.isZero() ? `+${fixed}` : fixed;
}
