import "server-only";
import { and, count, eq, gte } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { z } from "zod";
import { CATALOGS } from "@/i18n/catalogs";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, users } from "@/server/db/schema";
import { type Mailer } from "@/server/notifications/mailer";
import { RecordStateError, RecordValidationError } from "@/server/records/errors";
import { type DocumentDraft, type DocumentTotals } from "../domain/types";
import { getDocument } from "./document-service";
import { getDocumentPdf } from "./pdf-service";

/**
 * Sends an issued document's PDF by email (documents.create — the people who prepare documents).
 * The text is in the document's own language; replies go to the member who sent it. Drafts are
 * never sent. Each sending is audited with the delivery result only (no address, no content), and a
 * company may send at most SEND_LIMIT_PER_HOUR documents per hour.
 */

export const SEND_LIMIT_PER_HOUR = 100;
const MESSAGE_MAX = 2000;

const inputSchema = z.strictObject({ to: z.unknown(), message: z.unknown().optional() });
const emailSchema = z.email().max(254);

export async function sendDocumentEmail(
  db: Database,
  mailer: Mailer,
  actor: Actor,
  companyId: string,
  documentId: string,
  input: unknown,
): Promise<{ delivery: "sent" | "failed" }> {
  await requireCompanyAccess(db, actor, companyId, ["documents.view", "documents.create"]);
  const raw = inputSchema.parse(input);
  const issues: { code: string; severity: "error"; path: string }[] = [];
  const to = emailSchema.safeParse(typeof raw.to === "string" ? raw.to.trim() : raw.to);
  if (!to.success) issues.push({ code: "invalid_email", severity: "error", path: "to" });
  const message = raw.message === undefined || raw.message === null ? "" : raw.message;
  if (typeof message !== "string" || message.length > MESSAGE_MAX)
    issues.push({ code: "invalid_message", severity: "error", path: "message" });
  if (!to.success || typeof message !== "string" || issues.length)
    throw new RecordValidationError(issues);

  const stored = await getDocument(db, actor, companyId, documentId);
  if (stored.status !== "issued") throw new RecordStateError("document.notIssued");
  if (!mailer.configured) throw new RecordStateError("email.notConfigured");
  const [sent] = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, companyId),
        eq(auditLogs.action, "document.emailed"),
        gte(auditLogs.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
      ),
    );
  if ((sent?.n ?? 0) >= SEND_LIMIT_PER_HOUR) throw new RecordStateError("email.rateLimited");

  const doc = stored.draft as DocumentDraft & { number: string; totals: DocumentTotals | null };
  const { bytes, filename } = await getDocumentPdf(db, actor, companyId, documentId);
  const [sender] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actor.userId));

  const t = createTranslator({
    locale: doc.language,
    messages: CATALOGS[doc.language],
    namespace: "email.document",
  });
  const tPdf = createTranslator({
    locale: doc.language,
    messages: CATALOGS[doc.language],
    namespace: "documentPdf",
  });
  const title = `${tPdf(`title.${doc.type}`)} ${doc.number}`;
  const lines = [
    t("greeting"),
    "",
    ...(message.trim() ? [message.trim(), ""] : []),
    t("attached", { document: title, seller: doc.seller.name }),
  ];
  if (doc.totals && doc.type !== "delivery_note")
    lines.push(`${tPdf("grossTotal")}: ${doc.totals.grossTotal} ${doc.totals.currency}`);
  if (doc.type === "invoice" && doc.dueDate) lines.push(`${tPdf("dueDate")}: ${doc.dueDate}`);
  lines.push("", t("reply"), "", "—", t("footer", { seller: doc.seller.name }));

  const result = await mailer.send({
    kind: "document",
    to: to.data,
    replyTo: sender?.email,
    subject: `${title} — ${doc.seller.name}`,
    text: `${lines.join("\n")}\n`,
    attachments: [{ filename, contentType: "application/pdf", content: bytes }],
  });
  const delivery = result.status === "sent" ? "sent" : "failed";
  await recordAudit(db, {
    companyId,
    actorUserId: actor.userId,
    action: "document.emailed",
    entityType: "document",
    entityId: documentId,
    metadata: { delivery },
  });
  return { delivery };
}
