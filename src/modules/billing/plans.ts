/** Subscription plans shown to users; the charged amount is the Stripe price with the lookup key. */
export const PLANS = ["basic", "pro", "business"] as const;
export type Plan = (typeof PLANS)[number];
/** Monthly prices in EUR, as configured in Stripe. */
export const PLAN_PRICES: Record<Plan, string> = { basic: "6.99", pro: "12.99", business: "19.99" };
/** One free trial per company, without a card; it ends unless a payment method is added. */
export const TRIAL_DAYS = 2;
export const lookupKeyOf = (plan: Plan) => `alvoxis_flow_${plan}_monthly`;
