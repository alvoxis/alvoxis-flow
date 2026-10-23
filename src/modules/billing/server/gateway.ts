import "server-only";
import { getServerEnv } from "@/config/env";
import { createStripeGateway, type StripeGateway } from "./stripe-gateway";

/** The Stripe gateway for this deployment, or null when STRIPE_SECRET_KEY is not set. */
export function getStripeGateway(): StripeGateway | null {
  const key = getServerEnv().STRIPE_SECRET_KEY;
  return key ? createStripeGateway(key) : null;
}
