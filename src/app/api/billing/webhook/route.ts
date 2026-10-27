import { getServerEnv } from "@/config/env";
import { handleBillingEvent } from "@/modules/billing/server/billing-service";
import { getStripeGateway } from "@/modules/billing/server/gateway";
import { verifyStripeSignature } from "@/modules/billing/server/webhook-signature";
import { getDb } from "@/server/db/client";
import { ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

/** Stripe sends at most a few hundred kilobytes; anything larger is not a Stripe event. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Stripe webhook endpoint (`/api/billing/webhook`). Accepts only events whose signature verifies
 * with STRIPE_WEBHOOK_SECRET (and whose timestamp is recent), stores each event id once and then
 * refreshes the company's subscription from Stripe. Answers: 200 `{ received, outcome }`, 400 for
 * a missing or wrong signature or body, 503 when webhooks are not configured, 500 when refreshing
 * failed (Stripe retries). Event contents are never logged.
 */
export async function POST(request: Request) {
  const env = getServerEnv();
  const gateway = getStripeGateway();
  if (!env.STRIPE_WEBHOOK_SECRET || !gateway) return ok({ error: "not_configured" }, 503);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return ok({ error: "invalid_request" }, 400);
  const payload = await request.text();
  if (payload.length > MAX_BODY_BYTES) return ok({ error: "invalid_request" }, 400);
  const valid = verifyStripeSignature({
    payload,
    header: request.headers.get("stripe-signature"),
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  if (!valid) return ok({ error: "invalid_signature" }, 400);
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return ok({ error: "invalid_request" }, 400);
  }
  try {
    const outcome = await handleBillingEvent(getDb(), gateway, event);
    return ok({ received: true, outcome });
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError")
      return ok({ error: "invalid_request" }, 400);
    console.error(
      `[billing] webhook processing failed: ${err instanceof Error ? err.name : "unknown"}`,
    );
    return ok({ error: "processing_failed" }, 500);
  }
}
