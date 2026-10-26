/**
 * Subscription access policy (pure; used by the authorization guard and the UI).
 *
 * The Stripe subscription status decides; this application never grants access on its own
 * (a checkout success redirect proves nothing). With an inactive subscription a company is
 * READ-ONLY: everything stays visible and exportable (documents, PDFs, CSV exports, reports),
 * account, members, settings and billing keep working, but business data cannot be created or
 * changed and the AI assistant is unavailable. No data is ever deleted because of billing.
 *
 * | Stripe status                    | Access     | Shown as            |
 * | -------------------------------- | ---------- | ------------------- |
 * | active                           | full       | active              |
 * | trialing (earlier pricing only)  | full       | active              |
 * | past_due                         | full       | past due (warning)  | Stripe retries the payment;
 * |                                  |            |                     | it ends as unpaid/canceled.
 * | incomplete                       | read-only  | awaiting payment    |
 * | unpaid, paused                   | read-only  | payment required    |
 * | canceled, incomplete_expired     | read-only  | ended               |
 * | no subscription                  | read-only  | none                |
 *
 * A subscription cancelled "at period end" stays `active` until then, so access continues for the
 * time that was paid for. An operator may grant time-limited internal access (testing, support);
 * such grants are audited.
 */

export type SubscriptionAccess = "full" | "read_only";

export type SubscriptionPhase =
  "active" | "past_due" | "awaiting_payment" | "payment_required" | "ended" | "none";

const FULL = new Set(["active", "trialing", "past_due"]);

/** Statuses in which the company has a subscription that is managed in the portal. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

export function phaseOf(status: string | null): SubscriptionPhase {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "incomplete":
      return "awaiting_payment";
    case "unpaid":
    case "paused":
      return "payment_required";
    case "canceled":
    case "incomplete_expired":
      return "ended";
    default:
      return "none";
  }
}

export interface AccessInput {
  /** Whether this deployment enforces subscriptions at all (see `subscriptionEnforced`). */
  enforced: boolean;
  status: string | null;
  /** End of an operator's internal access grant, if any. */
  grantExpiresAt: Date | null;
  now?: Date;
}

export function subscriptionAccess(input: AccessInput): SubscriptionAccess {
  if (!input.enforced) return "full";
  if (input.status !== null && FULL.has(input.status)) return "full";
  const now = input.now ?? new Date();
  if (input.grantExpiresAt && input.grantExpiresAt.getTime() > now.getTime()) return "full";
  return "read_only";
}

/**
 * Whether subscriptions are enforced on this deployment: `SUBSCRIPTION_ENFORCEMENT=on|off`, or by
 * default exactly when Stripe is configured (without Stripe nobody could subscribe, so locking
 * companies would only take their work away). Reads presence only, never a key's value.
 */
export function subscriptionEnforced(env: Record<string, string | undefined> = process.env) {
  const mode = env.SUBSCRIPTION_ENFORCEMENT?.trim().toLowerCase();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return Boolean(env.STRIPE_SECRET_KEY?.trim());
}
