import { describe, expect, it } from "vitest";
import {
  createStripeGateway,
  encodeForm,
  StripeRequestError,
} from "@/modules/billing/server/stripe-gateway";

/** The Stripe REST client: form encoding, the trial without a card, errors without secrets. */
const KEY = "sk_test_fake000";

function fakeFetch(response: { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("stripe gateway", () => {
  it("encodes nested values in Stripe's bracket notation", () => {
    expect(
      encodeForm({
        a: 1,
        b: { c: "x y", d: { e: true } },
        items: [{ price: "p_1", quantity: 1 }],
        keys: ["k1"],
        skip: undefined,
      }),
    ).toEqual([
      "a=1",
      "b%5Bc%5D=x%20y",
      "b%5Bd%5D%5Be%5D=true",
      "items%5B0%5D%5Bprice%5D=p_1",
      "items%5B0%5D%5Bquantity%5D=1",
      "keys%5B0%5D=k1",
    ]);
  });

  it("starts a trial without asking for a card and ends it without a payment method", async () => {
    const f = fakeFetch({ body: { url: "https://checkout.stripe.test/s" } });
    const gw = createStripeGateway(KEY, f.impl);
    const s = await gw.createCheckoutSession({
      customerId: "cus_1",
      priceId: "price_1",
      companyId: "c-1",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      locale: "lv",
      trialDays: 2,
    });
    expect(s.url).toBe("https://checkout.stripe.test/s");
    const body = decodeURIComponent(String(f.calls[0]!.init.body));
    expect(f.calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(body).toContain("mode=subscription");
    expect(body).toContain("payment_method_collection=if_required");
    expect(body).toContain("subscription_data[trial_period_days]=2");
    expect(body).toContain(
      "subscription_data[trial_settings][end_behavior][missing_payment_method]=cancel",
    );
    expect(body).toContain("subscription_data[metadata][company_id]=c-1");

    const g = fakeFetch({ body: { url: "u" } });
    await createStripeGateway(KEY, g.impl).createCheckoutSession({
      customerId: "cus_1",
      priceId: "price_1",
      companyId: "c-1",
      successUrl: "s",
      cancelUrl: "c",
      locale: "en",
      trialDays: null,
    });
    const paid = decodeURIComponent(String(g.calls[0]!.init.body));
    expect(paid).not.toContain("trial");
    expect(paid).not.toContain("payment_method_collection");
  });

  it("reads subscriptions with the period from the item and creates idempotent customers", async () => {
    const f = fakeFetch({
      body: {
        data: [
          {
            id: "sub_1",
            status: "trialing",
            trial_end: 1_800_000_000,
            cancel_at_period_end: false,
            created: 1_790_000_000,
            items: {
              data: [{ current_period_end: 1_800_000_100, price: { lookup_key: "k" } }],
            },
          },
        ],
      },
    });
    const [sub] = await createStripeGateway(KEY, f.impl).listSubscriptions("cus_1");
    expect(sub).toMatchObject({ id: "sub_1", status: "trialing", lookupKey: "k" });
    expect(sub!.currentPeriodEnd?.getTime()).toBe(1_800_000_100_000);
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(f.calls[0]!.url).toContain("customer=cus_1");

    const c = fakeFetch({ body: { id: "cus_9" } });
    await createStripeGateway(KEY, c.impl).createCustomer({
      name: "SIA",
      email: "o@example.test",
      companyId: "c-9",
    });
    expect((c.calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "alvoxis-flow-customer-c-9",
    );
  });

  it("reports failures by status and code only, never the key", async () => {
    const f = fakeFetch({ status: 402, body: { error: { code: "card_declined", message: KEY } } });
    const err = await createStripeGateway(KEY, f.impl)
      .findPrice("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeRequestError);
    expect((err as Error).message).toBe("Stripe request failed (402, card_declined)");
    expect((err as Error).message).not.toContain(KEY);
  });
});
