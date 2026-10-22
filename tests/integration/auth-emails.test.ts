import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database } from "@/server/db/client";
import { auditLogs, users } from "@/server/db/schema";
import { AuthClient, createTestAuth, STRONG_PASSWORD, uniqueEmail } from "./auth-harness";
import { openTestDb } from "./test-db";

/**
 * The security emails of a deployment whose public URL is a Vercel preview branch URL: every link
 * points to that URL (never localhost or another host), each scenario sends its message, and a
 * failing SMTP server neither breaks sign-up nor leaks anything. Synthetic addresses only.
 */
const PREVIEW_URL = "https://alvoxis-flow-git-main-team.vercel.app";

let db: Database;
let pool: Pool;
let h: ReturnType<typeof createTestAuth>;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  h = createTestAuth(db, { APP_URL: PREVIEW_URL });
});
afterAll(async () => pool.end());

const client = () => new AuthClient(h.auth, undefined, undefined, PREVIEW_URL);
const mails = (to: string) => h.mailer.outbox.filter((m) => m.to === to);
const linkOf = (to: string, kind: string) =>
  mails(to)
    .filter((m) => m.kind === kind)
    .at(-1)
    ?.text.match(/https?:\/\/\S+/)?.[0];

describe("security emails on a preview deployment", () => {
  it("links of every scenario point to the preview URL", async () => {
    const email = uniqueEmail("mail");
    expect(
      (
        await client().request("/sign-up/email", {
          body: { email, password: STRONG_PASSWORD, name: "Mail Tester", locale: "lv" },
        })
      ).status,
    ).toBe(200);

    // Confirm your email address
    const verify = linkOf(email, "verify")!;
    expect(verify.startsWith(`${PREVIEW_URL}/api/auth/verify-email?token=`)).toBe(true);
    expect((await client().openLink(verify)).status).toBeLessThan(400);

    // New sign-in (with the device), linking to the security page in the user's language
    const signIn = await client().request("/sign-in/email", {
      body: { email, password: STRONG_PASSWORD },
    });
    expect(signIn.status).toBe(200);
    expect(linkOf(email, "newSignIn")).toBe(`${PREVIEW_URL}/lv/account/security`);

    // Sign-up again with the same address: "you already have an account", no second account
    await client().request("/sign-up/email", {
      body: { email, password: STRONG_PASSWORD, name: "Again", locale: "lv" },
    });
    expect(linkOf(email, "existingAccount")).toBe(`${PREVIEW_URL}/lv/sign-in`);

    // Password reset and the confirmation afterwards
    await client().request("/request-password-reset", {
      body: { email, redirectTo: "/lv/reset-password" },
    });
    const reset = linkOf(email, "reset")!;
    expect(reset.startsWith(`${PREVIEW_URL}/api/auth/reset-password/`)).toBe(true);
    const token = new URL(reset).pathname.split("/").pop()!;
    expect(
      (
        await client().request("/reset-password", {
          body: { token, newPassword: "a-brand-new-long-password-77" },
        })
      ).status,
    ).toBe(200);
    expect(linkOf(email, "passwordChanged")).toBe(`${PREVIEW_URL}/lv/forgot-password`);

    // Every message is in the user's language, without placeholders, and links nowhere else.
    const sent = mails(email);
    expect(sent.map((m) => m.kind)).toEqual(
      expect.arrayContaining([
        "verify",
        "newSignIn",
        "existingAccount",
        "reset",
        "passwordChanged",
      ]),
    );
    for (const m of sent) {
      expect(m.subject.startsWith("ALVOXIS Flow: ")).toBe(true);
      expect(m.text).toContain("Labdien");
      expect(m.text).not.toMatch(/\{\w+\}|localhost|email\.\w+/);
      for (const url of m.text.match(/https?:\/\/\S+/g) ?? [])
        expect(url.startsWith(`${PREVIEW_URL}/`)).toBe(true);
    }
  });

  it("a failing SMTP server keeps sign-up working and records only the kind and status", async () => {
    const failing = createTestAuth(db, { APP_URL: PREVIEW_URL });
    failing.mailer.send = async () => ({ status: "failed", error: "Error" });
    const email = uniqueEmail("smtp-down");
    const res = await new AuthClient(failing.auth, undefined, undefined, PREVIEW_URL).request(
      "/sign-up/email",
      { body: { email, password: STRONG_PASSWORD, name: "Down", locale: "en" } },
    );
    expect(res.status).toBe(200);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const records = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, user!.id),
          eq(auditLogs.action, "notification.email_not_delivered"),
        ),
      );
    expect(records.map((r) => r.metadata)).toEqual([{ kind: "verify", status: "failed" }]);
    expect(JSON.stringify(records)).not.toContain(email);
  });
});
