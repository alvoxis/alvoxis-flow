import "server-only";

/**
 * The few Stripe calls billing needs, behind an interface so tests use a fake. The real client
 * talks to the Stripe REST API with the server-only secret key; errors never include the key or
 * request bodies.
 */
export interface StripeSubscriptionSnapshot {
  id: string;
  status: string;
  lookupKey: string | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  created: Date;
}

export interface StripeGateway {
  createCustomer(input: {
    name: string;
    email: string;
    companyId: string;
  }): Promise<{ id: string }>;
  /** The active price with this lookup key, or null. */
  findPrice(lookupKey: string): Promise<{ id: string } | null>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    companyId: string;
    successUrl: string;
    cancelUrl: string;
    locale: string;
    trialDays: number | null;
  }): Promise<{ url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  listSubscriptions(customerId: string): Promise<StripeSubscriptionSnapshot[]>;
}

export class StripeRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(`Stripe request failed (${status}${code ? `, ${code}` : ""})`);
    this.name = "StripeRequestError";
  }
}

/** application/x-www-form-urlencoded with Stripe's bracket notation for nested values. */
export function encodeForm(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object")
          out.push(...encodeForm(item as Record<string, unknown>, `${name}[${i}]`));
        else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === "object") {
      out.push(...encodeForm(value as Record<string, unknown>, name));
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return out;
}

const seconds = (v: unknown) => (typeof v === "number" ? new Date(v * 1000) : null);

type Json = Record<string, unknown>;

export function createStripeGateway(
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): StripeGateway {
  async function call(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<Json> {
    const body = encodeForm(params).join("&");
    const url = `https://api.stripe.com/v1${path}${method === "GET" && body ? `?${body}` : ""}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: method === "POST" ? body : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const error = (json.error ?? {}) as { code?: string; type?: string };
      throw new StripeRequestError(res.status, error.code ?? error.type ?? null);
    }
    return json;
  }

  return {
    async createCustomer({ name, email, companyId }) {
      const c = await call(
        "POST",
        "/customers",
        { name, email, metadata: { company_id: companyId } },
        `alvoxis-flow-customer-${companyId}`,
      );
      return { id: String(c.id) };
    },
    async findPrice(lookupKey) {
      const list = await call("GET", "/prices", {
        lookup_keys: [lookupKey],
        active: "true",
        limit: 1,
      });
      const first = (list.data as Json[] | undefined)?.[0];
      return first ? { id: String(first.id) } : null;
    },
    async createCheckoutSession(input) {
      const trial = input.trialDays
        ? {
            trial_period_days: input.trialDays,
            // No card is asked for during the trial; without one the subscription ends instead
            // of becoming paid, so nobody is charged without adding a payment method themselves.
            trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
          }
        : {};
      const s = await call("POST", "/checkout/sessions", {
        mode: "subscription",
        customer: input.customerId,
        client_reference_id: input.companyId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        locale: input.locale,
        ...(input.trialDays ? { payment_method_collection: "if_required" } : {}),
        subscription_data: { metadata: { company_id: input.companyId }, ...trial },
      });
      return { url: String(s.url) };
    },
    async createPortalSession({ customerId, returnUrl }) {
      const s = await call("POST", "/billing_portal/sessions", {
        customer: customerId,
        return_url: returnUrl,
      });
      return { url: String(s.url) };
    },
    async listSubscriptions(customerId) {
      const list = await call("GET", "/subscriptions", {
        customer: customerId,
        status: "all",
        limit: 10,
      });
      return ((list.data as Json[] | undefined) ?? []).map((sub) => {
        const item = ((sub.items as Json | undefined)?.data as Json[] | undefined)?.[0];
        const price = (item?.price ?? {}) as Json;
        return {
          id: String(sub.id),
          status: String(sub.status),
          lookupKey: typeof price.lookup_key === "string" ? price.lookup_key : null,
          trialEnd: seconds(sub.trial_end),
          // Newer API versions report the period on the item, older ones on the subscription.
          currentPeriodEnd: seconds(sub.current_period_end ?? item?.current_period_end),
          cancelAtPeriodEnd: sub.cancel_at_period_end === true,
          created: seconds(sub.created) ?? new Date(0),
        };
      });
    },
  };
}
