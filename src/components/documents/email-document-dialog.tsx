"use client";

import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, Field } from "@/components/ui/form";
import { sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

/**
 * Sends an issued document's PDF by email (`POST …/email`, documents.create). The address starts
 * as the buyer's email from the document; an optional message goes above the standard text. The
 * server decides everything (issued only, configured email, hourly limit). While sending, the
 * dialog cannot be closed and the button is disabled, so a double click sends one email.
 */
export function EmailDocumentDialog({
  companyId,
  documentId,
  number,
  buyerEmail,
  emailConfigured,
}: {
  companyId: string;
  documentId: string;
  number: string;
  buyerEmail: string;
  emailConfigured: boolean;
}) {
  const t = useTranslations("documents.email");
  const router = useRouter();
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const [to, setTo] = useState(buyerEmail);
  const [message, setMessage] = useState("");

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    const outcome = await sendRecord<"sent" | "failed">(
      `/api/companies/${companyId}/documents/${documentId}/email`,
      "POST",
      { to, message },
      "delivery",
    );
    inFlight.current = false;
    setPending(false);
    if (outcome.kind === "ok")
      setNotice(
        outcome.value === "sent"
          ? { kind: "done", message: t("sent", { to }) }
          : { kind: "state", code: "email.failed" },
      );
    else setNotice(outcome);
  }

  if (!emailConfigured)
    return (
      <p className="text-xs text-muted" data-testid="email-not-configured">
        {t("notConfigured")}
      </p>
    );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (inFlight.current) return;
        if (next) {
          setNotice(null);
          setTo(buyerEmail);
          setMessage("");
        }
        setOpen(next);
      }}
    >
      <AlertDialogTrigger
        render={<Button type="button" variant="secondary" />}
        data-testid="email-open"
      >
        {t("open")}
      </AlertDialogTrigger>
      <AlertDialogContent
        initialFocus={cancelRef}
        data-testid="email-dialog"
        className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto"
      >
        <AlertDialogTitle className="text-base font-semibold text-text">
          {t("title", { number })}
        </AlertDialogTitle>
        <AlertDialogDescription className="text-sm text-muted">
          {t("description")}
        </AlertDialogDescription>
        <form
          id={`${id}-form`}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Field
            label={t("to")}
            name="to"
            type="email"
            required
            maxLength={254}
            value={to}
            disabled={pending}
            onChange={(e) => setTo(e.target.value)}
          />
          <label className="block space-y-1.5" htmlFor={`${id}-message`}>
            <span className="block text-sm font-medium text-text">{t("message")}</span>
            <textarea
              id={`${id}-message`}
              name="message"
              rows={4}
              maxLength={2000}
              value={message}
              disabled={pending}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none"
            />
          </label>
        </form>
        <RecordNotice
          notice={notice}
          onReload={() => router.refresh()}
          stateText={(code) =>
            t.has(`state.${code}` as Parameters<typeof t>[0])
              ? t(`state.${code}` as Parameters<typeof t>[0])
              : t("state.email.failed")
          }
        />
        <AlertDialogFooter>
          <Button
            type="submit"
            form={`${id}-form`}
            disabled={pending || !to.trim()}
            aria-busy={pending || undefined}
            data-testid="email-send"
          >
            {t("send")}
          </Button>
          <AlertDialogCancel ref={cancelRef} disabled={pending}>
            {t("close")}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
