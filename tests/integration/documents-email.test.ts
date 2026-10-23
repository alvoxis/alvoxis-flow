import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { createDraft, issueDocument } from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { auditLogs, companies, users } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { type Mailer, MemoryMailer } from "@/server/notifications/mailer";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import { addFixtureTaxCategories, withCategoryIds } from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Sending an issued document by email over the real route handler, services, PDF renderer and
 * database (only the session lookup and the mailer are stubbed): the PDF attachment, text in the
 * document's language, reply-to, permissions, drafts refused, not-configured email, the hourly
 * limit, audit without addresses, isolation. Synthetic data only; nothing is sent anywhere.
 */
const session = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: null as { userId: string; twoFactorVerified: boolean } | null,
  mailer: undefined as unknown,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({}),
  getMailer: () => session.mailer,
}));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => session.db,
}));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireUser: async () => {
    if (!session.actor) throw new UnauthenticatedError();
    return { ...session.actor, sessionId: "test-session" };
  },
}));

const emailRoute =
  await import("@/app/api/companies/[companyId]/documents/[documentId]/email/route");
const { SEND_LIMIT_PER_HOUR } = await import("@/modules/documents/server/email-service");

let db: Database;
let pool: Pool;
let mail: MemoryMailer;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  session.db = db;
});
afterAll(async () => pool.end());
beforeEach(() => {
  session.actor = null;
  mail = new MemoryMailer();
  session.mailer = mail;
});

const h = routeHelpers(() => db);
const as = (actor: Actor | null) => {
  session.actor = actor;
};
const send = (companyId: string, documentId: string, body: unknown) =>
  call(emailRoute.POST(req("POST", body), params({ companyId, documentId })));

async function companyWithDocuments(language: "en" | "lv" = "en") {
  const c = await h.newCompany("Sūtītājs SIA");
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, c.companyId));
  await ensureDefaultNumberSeries(db, c.owner, c.companyId);
  const cats = await addFixtureTaxCategories(db, c.owner, c.companyId);
  const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft({ language });
  const input = {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _id, sourceLineId: _s, ...l }) => l),
      cats,
    ),
  };
  const draft = await createDraft(db, c.owner, c.companyId, input);
  const issuedDoc = await issueDocument(db, c.owner, c.companyId, draft.id, draft.version);
  const otherDraft = await createDraft(db, c.owner, c.companyId, input);
  return { ...c, issued: issuedDoc, draft: otherDraft };
}

describe("sending documents by email", () => {
  it("sends the issued PDF with text in the document's language and replies to the sender", async () => {
    const c = await companyWithDocuments("lv");
    as(c.owner);
    const res = await send(c.companyId, c.issued.id, {
      to: " pircejs@example.test ",
      message: "Paldies par sadarbību!",
    });
    expect(res).toEqual({ status: 200, body: { delivery: "sent" } });
    expect(mail.outbox).toHaveLength(1);
    const msg = mail.outbox[0]!;
    const [owner] = await db.select().from(users).where(eq(users.id, c.owner.userId));
    expect(msg).toMatchObject({
      kind: "document",
      to: "pircejs@example.test",
      replyTo: owner!.email,
    });
    expect(msg.subject).toContain(c.issued.number!);
    expect(msg.text).toContain("Labdien!");
    expect(msg.text).toContain("Paldies par sadarbību!");
    expect(msg.text).toContain("Kopā: 1320.00 EUR");
    expect(msg.text).toContain("Apmaksas termiņš: 2026-03-16");
    expect(msg.attachments).toHaveLength(1);
    const pdf = msg.attachments![0]!;
    expect(pdf.filename).toBe(`${c.issued.number}.pdf`);
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.content.subarray(0, 5).toString()).toBe("%PDF-");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, c.companyId), eq(auditLogs.action, "document.emailed")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ delivery: "sent" });
    expect(JSON.stringify(audits)).not.toContain("pircejs@");
  });

  it("validates, refuses drafts and unconfigured email, and reports failures", async () => {
    const c = await companyWithDocuments();
    as(c.owner);
    const bad = await send(c.companyId, c.issued.id, { to: "nope", message: "x".repeat(2001) });
    expect(bad.status).toBe(422);
    expect(issueCodes(bad.body)).toEqual(["invalid_email", "invalid_message"]);
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test", cc: "b" })).status).toBe(
      422,
    );
    expect((await send(c.companyId, c.draft.id, { to: "a@example.test" })).body).toMatchObject({
      error: "invalid_state",
      code: "document.notIssued",
    });

    session.mailer = {
      configured: false,
      transport: "disabled",
      send: async () => ({ status: "not_configured" }),
    } satisfies Mailer;
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test" })).body).toMatchObject({
      code: "email.notConfigured",
    });

    session.mailer = {
      configured: true,
      transport: "smtp",
      send: async () => ({ status: "failed", error: "Error" }),
    } satisfies Mailer;
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test" })).body).toEqual({
      delivery: "failed",
    });
    expect(mail.outbox).toHaveLength(0);
  });

  it("limits sending per hour", async () => {
    const c = await companyWithDocuments();
    await db.insert(auditLogs).values(
      Array.from({ length: SEND_LIMIT_PER_HOUR }, () => ({
        companyId: c.companyId,
        actorUserId: c.owner.userId,
        action: "document.emailed",
        entityType: "document",
        entityId: c.issued.id,
        metadata: { delivery: "sent" },
      })),
    );
    as(c.owner);
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test" })).body).toMatchObject({
      code: "email.rateLimited",
    });
    expect(mail.outbox).toHaveLength(0);
  });

  it("needs documents.create and isolates companies", async () => {
    const c = await companyWithDocuments();
    const other = await h.newCompany("Cits SIA");
    as(await h.member(c.companyId, "manager"));
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test" })).status).toBe(200);
    as(await h.customMember(c.companyId, ["documents.view"]));
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test" })).status).toBe(403);
    as(other.owner);
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test" })).status).toBe(403);
    expect((await send(other.companyId, c.issued.id, { to: "a@example.test" })).status).toBe(404);
    as(null);
    expect((await send(c.companyId, c.issued.id, { to: "a@example.test" })).status).toBe(401);
    expect(mail.outbox).toHaveLength(1);
  });
});
