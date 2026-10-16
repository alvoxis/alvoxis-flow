import { and, eq, gt } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, authAccounts, authVerifications, users } from "@/server/db/schema";
import { type Database } from "@/server/db/client";
import {
  authFlows,
  AuthClient,
  createTestAuth,
  STRONG_PASSWORD,
  uniqueEmail,
} from "./auth-harness";
import { openTestDb } from "./test-db";

let db: Database;
let pool: Pool;
let h: ReturnType<typeof createTestAuth>;
let flows: ReturnType<typeof authFlows>;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  h = createTestAuth(db);
  flows = authFlows(h);
});
afterAll(async () => pool.end());

const linkFor = (to: string, kind: string) => flows.linkFor(to, kind);
const registerAndVerify = (
  ...args: Parameters<ReturnType<typeof authFlows>["registerAndVerify"]>
) => flows.registerAndVerify(...args);

describe("registration and email verification", () => {
  it("registers, requires verification before sign-in, and verifies via the emailed link", async () => {
    const email = uniqueEmail();
    const c = new AuthClient(h.auth);
    const res = await c.request("/sign-up/email", {
      body: { email, password: STRONG_PASSWORD, name: "Anna", locale: "lv" },
    });
    expect(res.status).toBe(200);
    expect(c.cookies.size).toBe(0); // no session before verification

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user).toMatchObject({
      displayName: "Anna",
      locale: "lv",
      emailVerified: false,
      emailVerifiedAt: null,
    });
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.userId, user!.id));
    expect(account!.providerId).toBe("credential");
    expect(account!.password).not.toContain(STRONG_PASSWORD);

    const blocked = await c.request("/sign-in/email", {
      body: { email, password: STRONG_PASSWORD },
    });
    expect(blocked.status).toBe(403);

    const link = linkFor(email, "verify");
    expect(link).toMatch(/\/api\/auth\/verify-email\?token=/);
    const verified = await c.openLink(link!);
    expect([200, 302]).toContain(verified.status);
    const [after] = await db.select().from(users).where(eq(users.id, user!.id));
    expect(after!.emailVerified).toBe(true);
    expect(after!.emailVerifiedAt).toBeInstanceOf(Date);

    const ok = await c.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
    expect(ok.status).toBe(200);
    const sessionCookie = [...ok.headers.getSetCookie()].find((v) =>
      v.startsWith("alvoxis.session_token="),
    );
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });
});

const signedIn = (...args: Parameters<ReturnType<typeof authFlows>["signedIn"]>) =>
  flows.signedIn(...args);

describe("account enumeration and credential errors", () => {
  it("answers a duplicate sign-up exactly like a new one and warns the real owner by email", async () => {
    const { email } = await registerAndVerify();
    const fresh = await new AuthClient(h.auth).request("/sign-up/email", {
      body: { email: uniqueEmail(), password: STRONG_PASSWORD, name: "X" },
    });
    const dup = await new AuthClient(h.auth).request("/sign-up/email", {
      body: { email, password: STRONG_PASSWORD, name: "X" },
    });
    expect(dup.status).toBe(fresh.status);
    expect(Object.keys(dup.json ?? {}).sort()).toEqual(Object.keys(fresh.json ?? {}).sort());
    expect(await db.$count(users, eq(users.email, email))).toBe(1);
    expect(linkFor(email, "existingAccount")).toMatch(/\/sign-in$/);
  });

  it("returns the same error for a wrong password and an unknown email, and audits failures", async () => {
    const { email } = await registerAndVerify();
    const wrong = await new AuthClient(h.auth).request("/sign-in/email", {
      body: { email, password: "definitely-not-it-123" },
    });
    const unknown = await new AuthClient(h.auth).request("/sign-in/email", {
      body: { email: uniqueEmail(), password: "definitely-not-it-123" },
    });
    expect(wrong.status).toBe(unknown.status);
    expect(wrong.json?.code).toBe(unknown.json?.code);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const failures = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorUserId, user!.id), eq(auditLogs.action, "auth.sign_in_failed")));
    expect(failures).toHaveLength(1);
  });

  it("rejects short passwords", async () => {
    const res = await new AuthClient(h.auth).request("/sign-up/email", {
      body: { email: uniqueEmail(), password: "short-pass", name: "X" },
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits repeated sign-in attempts from one IP", async () => {
    const c = new AuthClient(h.auth);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push(
        (
          await c.request("/sign-in/email", {
            body: { email: uniqueEmail(), password: "wrong-password-123" },
          })
        ).status,
      );
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another IP is not affected.
    expect(
      (
        await new AuthClient(h.auth).request("/sign-in/email", {
          body: { email: uniqueEmail(), password: "wrong-password-123" },
        })
      ).status,
    ).toBe(401);
  });
});

describe("password reset", () => {
  it("is generic for unknown emails, stores only a token hash, works once and revokes sessions", async () => {
    const { email } = await registerAndVerify();
    const { c: other } = await signedIn(email);
    expect(other.cookies.size).toBeGreaterThan(0);

    const unknown = await new AuthClient(h.auth).request("/request-password-reset", {
      body: { email: uniqueEmail(), redirectTo: "/en/reset-password" },
    });
    const known = await new AuthClient(h.auth).request("/request-password-reset", {
      body: { email, redirectTo: "/en/reset-password" },
    });
    expect(known.status).toBe(unknown.status);
    expect(known.json).toEqual(unknown.json);

    const link = linkFor(email, "reset")!;
    const token = new URL(link).pathname.split("/").pop()!;
    const stored = await db.select().from(authVerifications);
    expect(stored.some((v) => v.identifier.includes(token) || v.value.includes(token))).toBe(false);

    const c = new AuthClient(h.auth);
    const newPassword = "a-brand-new-long-password-77";
    expect((await c.request("/reset-password", { body: { token, newPassword } })).status).toBe(200);
    expect(
      (
        await c.request("/reset-password", {
          body: { token, newPassword: "yet-another-password-99" },
        })
      ).status,
    ).toBe(400);

    // Existing sessions were revoked; the new password works, the old one does not.
    expect((await other.request("/get-session")).json).toBeNull();
    expect((await signedIn(email, STRONG_PASSWORD)).res.status).toBe(401);
    expect((await signedIn(email, newPassword)).res.status).toBe(200);
    expect(linkFor(email, "passwordChanged")).not.toBeNull();
  });

  it("rejects expired reset tokens", async () => {
    const { email } = await registerAndVerify();
    await new AuthClient(h.auth).request("/request-password-reset", {
      body: { email, redirectTo: "/en/reset-password" },
    });
    const token = new URL(linkFor(email, "reset")!).pathname.split("/").pop()!;
    // Expire this user's reset token (stored hashed, so match on its expiry window instead).
    await db
      .update(authVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(gt(authVerifications.expiresAt, new Date(Date.now() + 30 * 60 * 1000)));
    expect(
      (
        await new AuthClient(h.auth).request("/reset-password", {
          body: { token, newPassword: "a-brand-new-long-password-77" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("password change", () => {
  it("always signs out other sessions, even if the client asks otherwise", async () => {
    const { email } = await registerAndVerify();
    const { c: a } = await signedIn(email);
    const { c: b } = await signedIn(email);
    const res = await a.request("/change-password", {
      body: {
        currentPassword: STRONG_PASSWORD,
        newPassword: "changed-password-long-1",
        revokeOtherSessions: false,
      },
    });
    expect(res.status).toBe(200);
    expect((await b.request("/get-session")).json).toBeNull();
    expect((await a.request("/get-session")).json).not.toBeNull();
  });
});

describe("audit hygiene", () => {
  it("never stores passwords, tokens or codes in audit metadata", async () => {
    const rows = await db.select().from(auditLogs);
    const blob = JSON.stringify(rows.map((r) => r.metadata));
    expect(blob).not.toContain(STRONG_PASSWORD);
    expect(blob).not.toMatch(/token=|"password"|"code":"\d{6}"/);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "auth.user_registered",
        "auth.email_verified",
        "auth.session_created",
        "auth.sign_in_failed",
        "auth.password_changed",
        "auth.password_reset_completed",
      ]),
    );
  });
});
