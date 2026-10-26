import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Stripe webhook signature (`Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`) as Stripe
 * documents it: HMAC-SHA256 of `${t}.${rawBody}` with the endpoint's signing secret, compared in
 * constant time against every v1 entry, and a timestamp no further than `toleranceSeconds` from now
 * (replay protection). The raw body must be used exactly as received.
 */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | null;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  if (!input.header || !input.secret) return false;
  const parts = input.header.split(",").map((p) => p.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(
    createHmac("sha256", input.secret)
      .update(`${timestamp}.${input.payload}`, "utf8")
      .digest("hex"),
    "utf8",
  );
  return signatures.some((sig) => {
    const given = Buffer.from(sig, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Builds a valid header for tests and local tooling (never used to accept events). */
export function signStripePayload(payload: string, secret: string, timestamp: number): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
