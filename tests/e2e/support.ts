import { createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  test as base,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

const MAIL_DIR = "tmp/e2e-mail";
export const PASSWORD = "correct-horse-battery-staple-42";

export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

/** Waits for an email of `kind` to `to` written by the file transport and returns its first link. */
export async function mailLink(to: string, kind: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try {
      files = readdirSync(MAIL_DIR).sort().reverse();
    } catch {
      /* directory not created yet */
    }
    for (const f of files) {
      const msg = JSON.parse(readFileSync(path.join(MAIL_DIR, f), "utf8")) as {
        to: string;
        kind: string;
        text: string;
      };
      if (msg.to === to && msg.kind === kind) return msg.text.match(/https?:\/\/\S+/)![0];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No "${kind}" email for ${to}`);
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP, as an authenticator app computes it. */
export function totp(secret: string, at = Date.now()): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Registers and verifies a user through the real HTTP endpoints (fast path for non-auth tests). */
export async function createVerifiedUser(
  request: APIRequestContext,
  baseURL: string,
  email = uniqueEmail(),
) {
  const res = await request.post("/api/auth/sign-up/email", {
    data: {
      email,
      password: PASSWORD,
      name: "E2E User",
      locale: "en",
      callbackURL: "/en/sign-in?verified=1",
    },
    headers: { origin: baseURL },
  });
  expect(res.ok()).toBe(true);
  const link = await mailLink(email, "verify");
  expect((await request.get(link, { maxRedirects: 0 })).status()).toBeLessThan(400);
  return email;
}

export async function signInViaForm(page: Page, email: string, locale = "en", password = PASSWORD) {
  await page.goto(`/${locale}/sign-in`);
  await page.getByTestId("sign-in-form").locator("input[name=email]").fill(email);
  await page.getByTestId("sign-in-form").locator("input[name=password]").fill(password);
  await page.getByTestId("sign-in-form").getByRole("button").click();
}

export async function signedInPage(page: Page, baseURL: string, locale = "en") {
  const email = await createVerifiedUser(page.request, baseURL);
  await signInViaForm(page, email, locale);
  await expect(page).toHaveURL(new RegExp(`/${locale}$`));
  return email;
}

export function randomIp(): string {
  const n = () => Math.floor(Math.random() * 250) + 1;
  return `10.${n()}.${n()}.${n()}`;
}

/** A separate browser "device" with its own client IP. */
export function newDevice(browser: Browser, options: BrowserContextOptions = {}) {
  return browser.newContext({
    ...options,
    extraHTTPHeaders: { ...(options.extraHTTPHeaders ?? {}), "x-forwarded-for": randomIp() },
  });
}

/** Every test runs as a distinct client (own IP) so per-client rate limits do not interfere. */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, provide) => {
    await provide({ ...(extraHTTPHeaders ?? {}), "x-forwarded-for": randomIp() });
  },
});
export { expect };

/** The page's own alert, excluding Next.js's always-present route announcer. */
export function alertOf(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
