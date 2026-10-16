import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, type MockInstance } from "vitest";
import { reencryptTwoFactorData, secretConfigFromEnv } from "@/server/auth/operator";
import { requireUser } from "@/server/auth/session";
import { type Database } from "@/server/db/client";
import { auditLogs, authSessions, twoFactors, users } from "@/server/db/schema";
import { TwoFactorChallengeRequiredError, UnauthenticatedError } from "@/server/errors";
import { FAKE_GOOGLE, type GoogleClaims, stubGoogleTokenEndpoint } from "../support/fake-google";
import { secretFromOtpauthUri, totp } from "../support/totp";
import {
  AuthClient,
  authFlows,
  createTestAuth,
  STRONG_PASSWORD,
  TEST_APP_URL,
  TEST_AUTH_SECRET,
  uniqueEmail,
} from "./auth-harness";
import { openTestDb } from "./test-db";

let db: Database;
let pool: Pool;
let h: ReturnType<typeof createTestAuth>;
let flows: ReturnType<typeof authFlows>;
let googleSpy: MockInstance | undefined;
let nextClaims: GoogleClaims;

beforeAll(() => {
  ({ db, pool } = openTestDb());
  h = createTestAuth(db, FAKE_GOOGLE);
  flows = authFlows(h);
});
afterEach(() => {
  googleSpy?.mockRestore();
  googleSpy = undefined;
});
afterAll(async () => pool.end());

const current = (c: AuthClient) => requireUser(h.auth, db, c.headers());
const userIdOf = async (email: string) =>
  (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;

/** Runs the real OAuth redirect + callback against the auth handler; only Google's token endpoint is faked. */
async function googleSignIn(c: AuthClient, claims: GoogleClaims) {
  nextClaims = claims;
  googleSpy ??= stubGoogleTokenEndpoint(() => nextClaims);
  const start = await c.request("/sign-in/social", {
    body: { provider: "google", callbackURL: "/en" },
  });
  expect(start.status).toBe(200);
  const state = new URL(String(start.json!.url)).searchParams.get("state")!;
  return c.request(`/callback/google?code=test-code&state=${encodeURIComponent(state)}`);
}

async function enrolledUser() {
  const { email } = await flows.registerAndVerify();
  const { c } = await flows.signedIn(email);
  const enable = await c.request("/two-factor/enable", { body: { password: STRONG_PASSWORD } });
  const secret = secretFromOtpauthUri(String(enable.json!.totpURI));
  expect(
    (await c.request("/two-factor/verify-totp", { body: { code: totp(secret) } })).status,
  ).toBe(200);
  return { email, secret };
}

describe("Google OAuth", () => {
  it("validates redirect targets and uses state + PKCE with the fixed callback URL", async () => {
    const c = new AuthClient(h.auth);
    const evil = await c.request("/sign-in/social", {
      body: { provider: "google", callbackURL: "https://evil.example/steal" },
    });
    expect(evil.status).toBe(403);

    const ok = await c.request("/sign-in/social", {
      body: { provider: "google", callbackURL: "/en" },
    });
    const url = new URL(String(ok.json!.url));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${TEST_APP_URL}/api/auth/callback/google`);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(JSON.stringify(ok.json)).not.toContain(FAKE_GOOGLE.GOOGLE_CLIENT_SECRET);

    // A callback with a forged state never produces a session.
    const forged = new AuthClient(h.auth);
    const res = await forged.request("/callback/google?code=x&state=forged-state");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=");
    await expect(current(forged)).rejects.toThrow(UnauthenticatedError);
  });

  it("signs in a new user whose Google address is verified", async () => {
    const c = new AuthClient(h.auth);
    const email = uniqueEmail("google");
    const res = await googleSignIn(c, { sub: `g-${email}`, email, email_verified: true });
    expect(res.status).toBe(302);
    const me = await current(c);
    expect(me).toMatchObject({ email, emailVerified: true });
  });

  it("gives no session to a Google account whose email address is not verified", async () => {
    const c = new AuthClient(h.auth);
    const email = uniqueEmail("google-unverified");
    await googleSignIn(c, { sub: `g-${email}`, email, email_verified: false });
    await expect(current(c)).rejects.toThrow(UnauthenticatedError);
    expect(await db.$count(authSessions, eq(authSessions.userId, await userIdOf(email)))).toBe(0);
  });

  it("does not link Google to a local account whose address was never verified (pre-registration takeover)", async () => {
    const email = uniqueEmail("prereg");
    const attacker = new AuthClient(h.auth);
    await attacker.request("/sign-up/email", {
      body: { email, password: STRONG_PASSWORD, name: "Attacker" },
    });
    const victim = new AuthClient(h.auth);
    await googleSignIn(victim, { sub: `g-${email}`, email, email_verified: true });
    await expect(current(victim)).rejects.toThrow(UnauthenticatedError);
  });

  it("a Google session of a 2FA user can do nothing until the second factor is passed", async () => {
    const { email, secret } = await enrolledUser();
    const c = new AuthClient(h.auth);
    await googleSignIn(c, { sub: `g-${email}`, email, email_verified: true });
    await expect(current(c)).rejects.toThrow(TwoFactorChallengeRequiredError);

    // Library endpoints that would otherwise reveal or replace the second factor, or change the
    // account, are refused for this session — even with the correct password.
    for (const [path, body] of [
      ["/two-factor/get-totp-uri", { password: STRONG_PASSWORD }],
      ["/two-factor/generate-backup-codes", { password: STRONG_PASSWORD }],
      ["/two-factor/enable", { password: STRONG_PASSWORD }],
      ["/two-factor/disable", { password: STRONG_PASSWORD }],
      ["/change-password", { currentPassword: STRONG_PASSWORD, newPassword: "x".repeat(20) }],
      ["/update-user", { name: "Changed" }],
      ["/link-social", { provider: "google", callbackURL: "/en" }],
    ] as const) {
      const res = await c.request(path, { body });
      expect({ path, status: res.status, code: res.json?.code }).toEqual({
        path,
        status: 403,
        code: "TWO_FACTOR_CHALLENGE_REQUIRED",
      });
    }

    // The step-up challenge and signing out stay available.
    expect((await c.request("/get-session")).status).toBe(200);
    expect(
      (
        await c.request("/two-factor/verify-totp", {
          body: { code: totp(secret, Date.now() + 30_000) },
        })
      ).status,
    ).toBe(200);
    await expect(current(c)).resolves.toMatchObject({ email, twoFactorVerified: true });
    expect((await c.request("/update-user", { body: { name: "Changed" } })).status).toBe(200);
  });
});

describe("unverified email addresses", () => {
  it("a user whose address is not verified is refused even with an existing session", async () => {
    const { email } = await flows.registerAndVerify();
    const { c } = await flows.signedIn(email);
    await expect(current(c)).resolves.toBeTruthy();
    await db.update(users).set({ emailVerified: false }).where(eq(users.email, email));
    await expect(current(c)).rejects.toThrow(UnauthenticatedError);
  });
});

describe("client IP and rate limiting", () => {
  it("throttles password guessing per account, whatever IP the client claims", async () => {
    const { email } = await flows.registerAndVerify();
    for (let i = 0; i < 10; i++) {
      const res = (await flows.signedIn(email, "wrong-password-guess")).res;
      expect(res.status).toBe(401);
    }
    // The 11th attempt — from yet another (spoofed) IP and even with the right password — is refused.
    const blocked = (await flows.signedIn(email)).res;
    expect(blocked.status).toBe(429);
  });

  it("answers unknown addresses exactly like known ones (no enumeration through the throttle)", async () => {
    const email = uniqueEmail("nobody");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await flows.signedIn(email, "guess")).res.status);
    expect(statuses).toEqual([...Array<number>(10).fill(401), 429]);
  });

  it("a successful sign-in resets the account's failure count", async () => {
    const { email } = await flows.registerAndVerify();
    for (let i = 0; i < 9; i++) await flows.signedIn(email, "wrong-password-guess");
    expect((await flows.signedIn(email)).res.status).toBe(200);
    for (let i = 0; i < 9; i++) await flows.signedIn(email, "wrong-password-guess");
    expect((await flows.signedIn(email)).res.status).toBe(200);
  });

  it("behind trusted proxies, takes the client IP from the right of the chain, not the spoofable left", async () => {
    const proxied = createTestAuth(db, { TRUSTED_PROXIES: "10.0.0.0/8" });
    const pFlows = authFlows(proxied);
    const { email } = await pFlows.registerAndVerify();
    // The client claims 203.0.113.9; the proxy (10.x) appended the real address 198.51.100.7.
    const c = new AuthClient(proxied.auth, "203.0.113.9, 198.51.100.7, 10.1.2.3");
    expect(
      (await c.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } })).status,
    ).toBe(200);
    const [session] = await db
      .select({ ip: authSessions.ipAddress })
      .from(authSessions)
      .where(eq(authSessions.userId, await userIdOf(email)));
    expect(session!.ip).toBe("198.51.100.7");
    const [entry] = await db
      .select({ ip: auditLogs.ipAddress })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, await userIdOf(email)),
          eq(auditLogs.action, "auth.session_created"),
        ),
      );
    expect(entry!.ip).toBe("198.51.100.7");
  });

  it("without trusted proxies, a multi-value forwarded header is not trusted for audit IPs", async () => {
    const { email } = await flows.registerAndVerify();
    const c = new AuthClient(h.auth, "6.6.6.6, 198.51.100.8");
    await c.request("/sign-in/email", { body: { email, password: "wrong-password-guess" } });
    const [entry] = await db
      .select({ ip: auditLogs.ipAddress })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, await userIdOf(email)),
          eq(auditLogs.action, "auth.sign_in_failed"),
        ),
      );
    // Never the client-controlled value (the library substitutes 127.0.0.1 only in test mode;
    // in production the address is simply unknown).
    expect(entry!.ip ?? "").not.toContain("6.6.6.6");
    expect(entry!.ip ?? "").not.toContain("198.51.100.8");
  });
});

describe("2FA key rotation", () => {
  const NEW_KEY = "rotated-integration-secret-not-for-production-0002";

  it("keeps enrolled 2FA working through rotation, re-encryption and retiring the old key", async () => {
    const { email, secret } = await enrolledUser();
    const id = await userIdOf(email);
    const [before] = await db.select().from(twoFactors).where(eq(twoFactors.userId, id));
    // Stored encrypted (XChaCha20-Poly1305), never as the plain secret.
    expect(before!.secret).not.toContain(secret);

    const signInAndVerify = async (auth: ReturnType<typeof createTestAuth>, at: number) => {
      const c = new AuthClient(auth.auth);
      const res = await c.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
      expect(res.json).toMatchObject({ twoFactorRedirect: true });
      const verify = await c.request("/two-factor/verify-totp", {
        body: { code: totp(secret, at) },
      });
      expect(verify.status).toBe(200);
    };

    // Step 1: deploy with the new key first; data written before rotation stays readable.
    const rotating = createTestAuth(db, {
      BETTER_AUTH_SECRETS: `2:${NEW_KEY},1:${TEST_AUTH_SECRET}`,
    });
    await signInAndVerify(rotating, Date.now() + 30_000);

    // Step 2: re-encrypt with the new key (idempotent).
    const key = secretConfigFromEnv(rotating.env);
    if (typeof key === "string") throw new Error("expected a versioned key");
    const first = await reencryptTwoFactorData(db, key);
    expect(first.unreadable).toEqual([]);
    expect(first.updated).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(twoFactors).where(eq(twoFactors.userId, id));
    expect(after!.secret.startsWith("$ba$2$")).toBe(true);
    expect(after!.backupCodes.startsWith("$ba$2$")).toBe(true);
    expect((await reencryptTwoFactorData(db, key)).updated).toBe(0);

    // Step 3: the old key is retired entirely; 2FA still works.
    const retired = createTestAuth(db, {
      BETTER_AUTH_SECRET: NEW_KEY,
      BETTER_AUTH_SECRETS: `2:${NEW_KEY}`,
    });
    await signInAndVerify(retired, Date.now() - 30_000);
  });
});
