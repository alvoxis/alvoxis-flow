/**
 * Compares two non-negative or negative decimal strings with up to 4 decimals exactly
 * (−1, 0, 1). Display only, e.g. whether a component is short for a planned order.
 */
export function compareDecimals(a: string, b: string): number {
  const scaled = (v: string) => {
    const neg = v.trim().startsWith("-");
    const [i = "0", f = ""] = v.trim().replace("-", "").split(".");
    const n = BigInt(i || "0") * 10000n + BigInt((f + "0000").slice(0, 4));
    return neg ? -n : n;
  };
  const d = scaled(a) - scaled(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}
