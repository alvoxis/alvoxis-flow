import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Transporter } from "nodemailer";
import { type ServerEnv } from "@/config/env";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Category for logs/metrics only; never includes content. */
  kind: string;
  /** Where replies go (e.g. the member who sent a document); the sender stays EMAIL_FROM. */
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export type DeliveryResult =
  { status: "sent" } | { status: "not_configured" } | { status: "failed"; error: string };

/**
 * Email delivery abstraction. Implementations never claim success they did not achieve:
 * "disabled" returns `not_configured`, so callers and the UI can tell the user plainly.
 */
export interface Mailer {
  readonly configured: boolean;
  readonly transport: "disabled" | "file" | "smtp" | "memory";
  send(message: EmailMessage): Promise<DeliveryResult>;
}

class DisabledMailer implements Mailer {
  readonly configured = false;
  readonly transport = "disabled" as const;
  async send(message: EmailMessage): Promise<DeliveryResult> {
    // Do not log recipient or content: messages may contain one-time links.
    console.warn(`[mailer] email delivery is not configured; "${message.kind}" email was NOT sent`);
    return { status: "not_configured" };
  }
}

/** Development/test only: writes each message as JSON so developers and e2e tests can open links. */
export class FileMailer implements Mailer {
  readonly configured = true;
  readonly transport = "file" as const;
  constructor(private readonly dir: string) {}
  async send(message: EmailMessage): Promise<DeliveryResult> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${Date.now()}-${randomUUID()}.json`);
    // Attachments are recorded by name, type and size only, never their content.
    const attachments = message.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.content.length,
    }));
    await writeFile(
      file,
      JSON.stringify({ ...message, attachments, sentAt: new Date().toISOString() }, null, 2),
    );
    return { status: "sent" };
  }
}

/** In-process mailer for integration tests. */
export class MemoryMailer implements Mailer {
  readonly configured = true;
  readonly transport = "memory" as const;
  readonly outbox: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<DeliveryResult> {
    this.outbox.push(message);
    return { status: "sent" };
  }
}

class SmtpMailer implements Mailer {
  readonly configured = true;
  readonly transport = "smtp" as const;
  private transporterPromise: Promise<Transporter> | undefined;
  constructor(private readonly env: ServerEnv) {}

  private transporter() {
    this.transporterPromise ??= import("nodemailer").then((nodemailer) =>
      nodemailer.createTransport({
        host: this.env.SMTP_HOST,
        port: this.env.SMTP_PORT,
        secure: this.env.SMTP_SECURE === "true",
        auth: this.env.SMTP_USER
          ? { user: this.env.SMTP_USER, pass: this.env.SMTP_PASSWORD }
          : undefined,
      }),
    );
    return this.transporterPromise;
  }

  async send(message: EmailMessage): Promise<DeliveryResult> {
    try {
      await (
        await this.transporter()
      ).sendMail({
        from: this.env.EMAIL_FROM,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments,
      });
      return { status: "sent" };
    } catch (err) {
      const error = err instanceof Error ? err.name : "unknown";
      console.error(`[mailer] SMTP delivery of "${message.kind}" failed: ${error}`);
      return { status: "failed", error };
    }
  }
}

export function createMailer(env: ServerEnv): Mailer {
  switch (env.EMAIL_TRANSPORT) {
    case "smtp":
      return new SmtpMailer(env);
    case "file":
      return new FileMailer(path.resolve(env.EMAIL_FILE_DIR));
    default:
      return new DisabledMailer();
  }
}
