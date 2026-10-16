import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDocuments } from "@/modules/documents/server/document-service";
import { requireCompanyAccess } from "@/server/auth/authorization";
import { requireUser, toActor } from "@/server/auth/session";
import {
  listMySessions,
  revokeMyOtherSessions,
  revokeMySession,
} from "@/server/auth/sessions-service";
import { type Database } from "@/server/db/client";
import { auditLogs, authSessions, memberships, roles, twoFactors, users } from "@/server/db/schema";
import {
  ForbiddenError,
  TwoFactorChallengeRequiredError,
  TwoFactorRequiredError,
  UnauthenticatedError,
} from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { secretFromOtpauthUri, totp } from "../support/totp";
import { AuthClient, authFlows, createTestAuth, STRONG_PASSWORD } from "./auth-harness";
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

const userId = async (email: string) =>
  (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;
const current = (c: AuthClient, opts = {}) => requireUser(h.auth, db, c.headers(), opts);

/** Enrols TOTP for a signed-in client; returns secret and recovery codes. */
async function enrol(c: AuthClient) {
  const enable = await c.request("/two-factor/enable", { body: { password: STRONG_PASSWORD } });
  expect(enable.status).toBe(200);
  const secret = secretFromOtpauthUri(String(enable.json!.totpURI));
  const backupCodes = enable.json!.backupCodes as string[];
  const verify = await c.request("/two-factor/verify-totp", { body: { code: totp(secret) } });
  expect(verify.status).toBe(200);
  return { secret, backupCodes };
}

describe("sessions and devices", () => {
  it("lists the user's sessions with device data, revokes one or all others, never other users' sessions", async () => {
    const { email } = await flows.registerAndVerify();
    const { c: laptop } = await flows.signedIn(email);
    const phone = new AuthClient(
      h.auth,
      undefined,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    );
    await phone.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
    const tablet = (await flows.signedIn(email)).c;

    const me = await current(laptop);
    const list = await listMySessions(db, me);
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.device.os === "iOS")).toMatchObject({
      device: { browser: "Safari", mobile: true },
    });
    expect(list.every((s) => s.createdAt instanceof Date && s.lastActiveAt instanceof Date)).toBe(
      true,
    );
    expect(JSON.stringify(list)).not.toMatch(/token/i);

    const phoneSession = list.find((s) => s.device.os === "iOS")!;
    const { email: otherEmail } = await flows.registerAndVerify();
    const stranger = await current((await flows.signedIn(otherEmail)).c);
    expect(await revokeMySession(db, stranger, phoneSession.id)).toBe(false);
    expect(await revokeMySession(db, me, phoneSession.id)).toBe(true);
    await expect(current(phone)).rejects.toThrow(UnauthenticatedError);

    expect(await revokeMyOtherSessions(db, me)).toBe(1);
    await expect(current(tablet)).rejects.toThrow(UnauthenticatedError);
    await expect(current(laptop)).resolves.toMatchObject({ email });
    const actions = (
      await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, me.userId))
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["auth.session_revoked", "auth.other_sessions_revoked"]),
    );
  });

  it("rejects missing/forged cookies and expired sessions", async () => {
    await expect(requireUser(h.auth, db, new Headers())).rejects.toThrow(UnauthenticatedError);
    await expect(
      requireUser(h.auth, db, new Headers({ cookie: "alvoxis.session_token=forged.value" })),
    ).rejects.toThrow(UnauthenticatedError);
    const { email } = await flows.registerAndVerify();
    const { c } = await flows.signedIn(email);
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.userId, await userId(email)));
    await expect(current(c)).rejects.toThrow(UnauthenticatedError);
  });

  it("locks out disabled users: no new sign-in and existing sessions stop working", async () => {
    const { email } = await flows.registerAndVerify();
    const { c } = await flows.signedIn(email);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, email));
    await expect(current(c)).rejects.toThrow(UnauthenticatedError);
    expect(await db.$count(authSessions, eq(authSessions.userId, await userId(email)))).toBe(0);
    const again = await new AuthClient(h.auth).request("/sign-in/email", {
      body: { email, password: STRONG_PASSWORD },
    });
    expect(again.status).not.toBe(200);
    expect(await db.$count(authSessions, eq(authSessions.userId, await userId(email)))).toBe(0);
  });
});

describe("two-factor authentication", () => {
  it("enrols only after a valid code, marks the session verified and signs out older sessions", async () => {
    const { email } = await flows.registerAndVerify();
    const { c } = await flows.signedIn(email);
    const { c: older } = await flows.signedIn(email);

    const enable = await c.request("/two-factor/enable", { body: { password: STRONG_PASSWORD } });
    expect(enable.json!.backupCodes).toHaveLength(10);
    // Not active until the authenticator is proven.
    expect((await db.select().from(users).where(eq(users.email, email)))[0]!.twoFactorEnabled).toBe(
      false,
    );
    const secret = secretFromOtpauthUri(String(enable.json!.totpURI));
    expect(
      (
        await c.request("/two-factor/verify-totp", {
          body: { code: "000000" === totp(secret) ? "111111" : "000000" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await c.request("/two-factor/verify-totp", { body: { code: totp(secret) } })).status,
    ).toBe(200);

    const me = await current(c);
    expect(me).toMatchObject({ twoFactorEnabled: true, twoFactorVerified: true });
    await expect(current(older)).rejects.toThrow(UnauthenticatedError);

    // Secret and recovery codes are encrypted at rest.
    const [tf] = await db.select().from(twoFactors).where(eq(twoFactors.userId, me.userId));
    expect(tf!.secret).not.toContain(secret);
    for (const code of enable.json!.backupCodes as string[])
      expect(tf!.backupCodes).not.toContain(code);
    expect(h.mailer.outbox.some((m) => m.to === email && m.kind === "twoFactorEnabled")).toBe(true);
  });

  it("requires the second factor at sign-in and rejects a replayed code", async () => {
    const { email } = await flows.registerAndVerify();
    const { secret } = await enrol((await flows.signedIn(email)).c);

    const pending = new AuthClient(h.auth);
    const step1 = await pending.request("/sign-in/email", {
      body: { email, password: STRONG_PASSWORD },
    });
    expect(step1.json?.twoFactorRedirect).toBe(true);
    await expect(current(pending)).rejects.toThrow(UnauthenticatedError); // no session yet

    // The enrollment code is still within its window: replaying it must fail.
    const replay = await pending.request("/two-factor/verify-totp", {
      body: { code: totp(secret) },
    });
    expect(replay.status).toBe(401);
    expect(replay.json?.code).toBe("CODE_ALREADY_USED");

    // The next time-step's code (accepted within the ±1 window) works once.
    const next = totp(secret, Date.now() + 30_000);
    expect(
      (await pending.request("/two-factor/verify-totp", { body: { code: next } })).status,
    ).toBe(200);
    await expect(current(pending)).resolves.toMatchObject({ twoFactorVerified: true });

    const attacker = new AuthClient(h.auth);
    await attacker.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
    expect(
      (await attacker.request("/two-factor/verify-totp", { body: { code: next } })).json?.code,
    ).toBe("CODE_ALREADY_USED");
    await expect(current(attacker)).rejects.toThrow(UnauthenticatedError);
  });

  it("accepts each recovery code once", async () => {
    const { email } = await flows.registerAndVerify();
    const { backupCodes } = await enrol((await flows.signedIn(email)).c);
    const a = new AuthClient(h.auth);
    await a.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
    expect(
      (await a.request("/two-factor/verify-backup-code", { body: { code: backupCodes[0] } }))
        .status,
    ).toBe(200);
    await expect(current(a)).resolves.toMatchObject({ twoFactorVerified: true });

    const b = new AuthClient(h.auth);
    await b.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
    expect(
      (await b.request("/two-factor/verify-backup-code", { body: { code: backupCodes[0] } }))
        .status,
    ).toBe(401);
    const actions = (
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.actorUserId, await userId(email)))
    ).map((x) => x.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "auth.two_factor_enabled",
        "auth.two_factor_recovery_code_used",
        "auth.two_factor_failed",
      ]),
    );
  });

  it("ignores 'trust this device': every sign-in still needs the second factor", async () => {
    const { email } = await flows.registerAndVerify();
    const { secret } = await enrol((await flows.signedIn(email)).c);
    const c = new AuthClient(h.auth);
    await c.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
    await c.request("/two-factor/verify-totp", {
      body: { code: totp(secret, Date.now() + 30_000), trustDevice: true },
    });
    await c.request("/sign-out", { body: {} });
    const again = await c.request("/sign-in/email", { body: { email, password: STRONG_PASSWORD } });
    expect(again.json?.twoFactorRedirect).toBe(true);
  });
});

describe("company access requires every authentication step", () => {
  async function ownerWithCompany() {
    const { email } = await flows.registerAndVerify();
    const { c } = await flows.signedIn(email);
    const me = await current(c);
    const { companyId } = await createCompanyWithOwner(db, toActor(me), {
      name: "Auth Test SIA",
      country: "LV",
    });
    return { email, c, companyId };
  }

  it("denies company data to an owner until 2FA is enrolled, without locking them out", async () => {
    const { c, companyId } = await ownerWithCompany();
    const me = await current(c);
    await expect(listDocuments(db, toActor(me), companyId)).rejects.toThrow(TwoFactorRequiredError);
    // The owner can still reach account pages and enrol.
    await enrol(c);
    const after = await current(c);
    await expect(listDocuments(db, toActor(after), companyId)).resolves.toEqual([]);
  });

  it("blocks owners from disabling 2FA on the server", async () => {
    const { c } = await ownerWithCompany();
    await enrol(c);
    const res = await c.request("/two-factor/disable", { body: { password: STRONG_PASSWORD } });
    expect(res.status).toBe(403);
    expect(res.json?.code).toBe("TWO_FACTOR_REQUIRED_FOR_ROLE");
    expect((await current(c)).twoFactorEnabled).toBe(true);
  });

  it("does not accept a session that skipped the second factor (e.g. Google sign-in) until a step-up challenge", async () => {
    const { email, c, companyId } = await ownerWithCompany();
    const { secret } = await enrol(c);
    // Simulate a session created by a provider that bypasses the 2FA plugin (Google OAuth).
    await db
      .update(authSessions)
      .set({ twoFactorVerifiedAt: null })
      .where(eq(authSessions.userId, await userId(email)));
    await expect(current(c)).rejects.toThrow(TwoFactorChallengeRequiredError);
    const pending = await current(c, { allowPendingTwoFactor: true });
    expect(pending.twoFactorVerified).toBe(false);
    // Even with a hand-built actor from that session, the company guard refuses.
    await expect(requireCompanyAccess(db, toActor(pending), companyId)).rejects.toThrow(
      TwoFactorRequiredError,
    );

    // Step-up on the existing session.
    expect(
      (
        await c.request("/two-factor/verify-totp", {
          body: { code: totp(secret, Date.now() + 30_000) },
        })
      ).status,
    ).toBe(200);
    const verified = await current(c);
    await expect(listDocuments(db, toActor(verified), companyId)).resolves.toEqual([]);
  });

  it("refuses users without a valid membership, suspended members and archived companies", async () => {
    const { companyId } = await ownerWithCompany();
    const { email } = await flows.registerAndVerify();
    const { c } = await flows.signedIn(email);
    const outsider = await current(c);
    await expect(listDocuments(db, toActor(outsider), companyId)).rejects.toThrow(ForbiddenError);

    const [role] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.companyId, companyId), eq(roles.key, "warehouse_employee")));
    await db
      .insert(memberships)
      .values({ companyId, userId: outsider.userId, roleId: role!.id, status: "suspended" });
    await expect(listDocuments(db, toActor(outsider), companyId)).rejects.toThrow(ForbiddenError);

    await db
      .update(memberships)
      .set({ status: "active" })
      .where(eq(memberships.userId, outsider.userId));
    await expect(listDocuments(db, toActor(outsider), companyId)).resolves.toEqual([]);
  });
});
