/**
 * The one subscription of ALVOXIS Flow. Everything about the price lives here; the charged amount
 * is the Stripe price found by `LOOKUP_KEY`, and checkout refuses a Stripe price whose amount,
 * currency or interval differ from these values (a misconfigured price never reaches a customer).
 * There is no free trial: the subscription begins when the first payment succeeds.
 */
export const PLAN = {
  id: "flow",
  /** Display price per company and month, EUR. */
  priceEur: "9.99",
  /** The same amount in cents, as Stripe reports `unit_amount`. */
  amountCents: 999,
  currency: "eur",
  interval: "month",
  lookupKey: "alvoxis_flow_monthly",
} as const;

export type Plan = typeof PLAN.id;

/**
 * Plans of the earlier pricing (Basic, Pro AI, Business). Subscriptions that exist on those prices
 * keep working and are shown as the one plan; nobody can start a new one.
 */
export const LEGACY_LOOKUP_KEYS: readonly string[] = [
  "alvoxis_flow_basic_monthly",
  "alvoxis_flow_pro_monthly",
  "alvoxis_flow_business_monthly",
];

/** The plan a Stripe price lookup key belongs to, or null for a foreign price. */
export function planOfLookupKey(key: string | null): Plan | null {
  if (key === PLAN.lookupKey || (key !== null && LEGACY_LOOKUP_KEYS.includes(key))) return PLAN.id;
  return null;
}
