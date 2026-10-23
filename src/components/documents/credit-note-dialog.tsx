"use client";

import { useTranslations } from "next-intl";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { IssueList } from "@/components/documents/issue-list";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, Button, Field } from "@/components/ui/form";
import { localToday } from "@/features/documents/create-model";
import {
  type CreditableLine,
  type CreditFormError,
  type CreditNoteForm,
  creditFormErrors,
  defaultCreditDate,
  toCreditNoteBody,
} from "@/features/documents/credit-note-model";
import {
  type ApiIssue,
  type ApiOutcome,
  interpretResponse,
} from "@/features/documents/editor-model";
import { type AppLocale, LOCALE_ENDONYMS, LOCALES } from "@/i18n/config";
import { Link, useRouter } from "@/i18n/navigation";

const noSubscription = () => () => {};

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Creates a credit-note DRAFT for an issued invoice (`POST …/credit-note`) and opens it in the
 * existing editor, where it is checked and issued as usual. Shown on issued invoices to users with
 * documents.create; the server decides everything else (remaining quantities and amounts, date,
 * access, numbering at issue) and its findings are shown in the dialog without closing it.
 *
 * Full mode credits whatever remains; partial mode sends the quantities typed per invoice line.
 * The dialog shows invoiced quantities only, not what remains (that is checked by the server).
 * While the request runs both actions are disabled and the dialog cannot be closed, so a double
 * click creates one draft.
 */
export function CreditNoteDialog({
  companyId,
  invoice,
}: {
  companyId: string;
  invoice: {
    id: string;
    number: string;
    issueDate: string;
    language: AppLocale;
    lines: CreditableLine[];
  };
}) {
  const t = useTranslations("documents");
  const tc = useTranslations("documents.creditNote");
  const tPdf = useTranslations("documentPdf");
  const tCompany = useTranslations("company");
  const router = useRouter();
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // A ref, not state: it blocks a second click that lands before React re-renders the buttons.
  // It stays set after success, while the browser moves to the new draft.
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<CreditNoteForm["mode"]>("full");
  const [language, setLanguage] = useState<AppLocale>(invoice.language);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  // Until edited, the date is the browser's calendar day (never before the invoice date).
  const today = useSyncExternalStore(noSubscription, localToday, () => "");
  const [editedDate, setEditedDate] = useState<string | null>(null);
  const issueDate = editedDate ?? (today ? defaultCreditDate(today, invoice.issueDate) : "");
  const [formErrors, setFormErrors] = useState<CreditFormError[]>([]);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [notice, setNotice] = useState<Exclude<ApiOutcome, { kind: "ok" | "invalid" }> | null>(
    null,
  );

  const form: CreditNoteForm = { mode, issueDate, language, quantities };
  const lineError = (lineId: string) => formErrors.find((e) => e.lineId === lineId);
  const generalErrors = formErrors.filter((e) => !e.lineId);

  function reset() {
    setMode("full");
    setLanguage(invoice.language);
    setQuantities({});
    setEditedDate(null);
    setFormErrors([]);
    setIssues([]);
    setNotice(null);
  }

  async function submit() {
    if (inFlight.current) return;
    const errors = creditFormErrors(form, invoice);
    setFormErrors(errors);
    setIssues([]);
    setNotice(null);
    if (errors.length > 0) return;
    inFlight.current = true;
    setPending(true);
    let outcome: ApiOutcome;
    try {
      const res = await fetch(`/api/companies/${companyId}/documents/${invoice.id}/credit-note`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toCreditNoteBody(form, invoice.lines)),
      });
      outcome = interpretResponse(res.status, await res.json().catch(() => null));
    } catch {
      outcome = { kind: "error" };
    }
    if (outcome.kind === "ok") {
      router.push(`/companies/${companyId}/documents/${outcome.document.id}`);
      return;
    }
    inFlight.current = false;
    setPending(false);
    if (outcome.kind === "invalid") setIssues(outcome.issues);
    else setNotice(outcome);
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Not while the request runs: Esc must not hide a credit note that is being created.
        if (inFlight.current) return;
        if (next) reset();
        setOpen(next);
      }}
    >
      <AlertDialogTrigger
        render={<Button type="button" variant="secondary" />}
        data-testid="credit-note-open"
      >
        {tc("create")}
      </AlertDialogTrigger>
      <AlertDialogContent
        initialFocus={cancelRef}
        data-testid="credit-note-dialog"
        className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto"
      >
        <AlertDialogTitle className="text-base font-semibold text-text">
          {tc("title", { number: invoice.number })}
        </AlertDialogTitle>
        <AlertDialogDescription className="text-sm text-muted">
          {tc("description")}
        </AlertDialogDescription>
        <form
          id={`${id}-form`}
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className="space-y-2" disabled={pending}>
            <legend className="mb-1 text-sm font-medium text-text">{tc("mode")}</legend>
            {(["full", "partial"] as const).map((m) => (
              <label
                key={m}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5 has-checked:border-accent/70"
              >
                <input
                  type="radio"
                  name="mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => {
                    setMode(m);
                    setFormErrors([]);
                  }}
                  className="mt-1 accent-violet-500"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{tc(`${m}.label`)}</span>
                  <span className="block text-xs text-muted">{tc(`${m}.hint`)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={tPdf("issueDate")}
              name="issueDate"
              type="date"
              required
              min={invoice.issueDate}
              value={issueDate}
              disabled={pending}
              aria-invalid={generalErrors.some((e) => e.code.startsWith("date")) || undefined}
              onChange={(e) => setEditedDate(e.target.value)}
            />
            <label className="block space-y-1.5" htmlFor={`${id}-language`}>
              <span className="block text-sm font-medium text-text">{t("new.language")}</span>
              <select
                id={`${id}-language`}
                name="language"
                value={language}
                disabled={pending}
                onChange={(e) => setLanguage(e.target.value as AppLocale)}
                className={selectClass}
              >
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_ENDONYMS[l]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {mode === "partial" ? (
            <fieldset className="space-y-2" disabled={pending} data-testid="credit-note-lines">
              <legend className="mb-1 text-sm font-medium text-text">{tc("linesTitle")}</legend>
              <p className="text-xs text-muted">{tc("linesHint")}</p>
              <ul className="space-y-2">
                {invoice.lines.map((line, i) => {
                  const error = lineError(line.id);
                  const errorId = `${id}-line-${i}-error`;
                  return (
                    <li
                      key={line.id}
                      className="grid gap-2 rounded-lg border border-border px-3 py-2.5 sm:grid-cols-[1fr_9rem] sm:items-center"
                      data-testid="credit-note-line"
                    >
                      <div className="min-w-0 text-sm">
                        <p className="break-words text-text">
                          {i + 1}. {line.description}
                        </p>
                        <p className="text-xs text-muted">
                          {tc("invoiced", {
                            quantity: `${line.quantity} ${line.unit ?? ""}`.trim(),
                          })}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <input
                          name={`credit.${i}`}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0"
                          aria-label={tc("quantityFor", {
                            n: i + 1,
                            description: line.description,
                          })}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? errorId : undefined}
                          value={quantities[line.id] ?? ""}
                          onChange={(e) =>
                            setQuantities((q) => ({ ...q, [line.id]: e.target.value }))
                          }
                          className={`tabular w-full rounded-lg border bg-surface-2 px-3 py-2.5 text-right text-sm text-text focus:border-accent focus:outline-none ${error ? "border-red-500" : "border-border"}`}
                        />
                        {error ? (
                          <p id={errorId} className="text-xs text-danger">
                            {tc(`errors.${error.code}`)}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ) : null}
        </form>

        {generalErrors.length > 0 ? (
          <Alert tone="error">
            <span data-testid="credit-note-form-error">
              {generalErrors.map((e) => tc(`errors.${e.code}`)).join(" ")}
            </span>
          </Alert>
        ) : null}
        <IssueList issues={issues} />
        {issues.length > 0 ? <Alert tone="error">{tc("refused")}</Alert> : null}
        {notice ? (
          <Alert tone="error">
            {notice.kind === "twoFactor" ? (
              <>
                {t("outcome.twoFactor")}{" "}
                <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
              </>
            ) : notice.kind === "state" && notice.code.startsWith("source.") ? (
              tc("notCreditable")
            ) : notice.kind === "conflict" || notice.kind === "notDraft" ? (
              t("outcome.state")
            ) : (
              t(`outcome.${notice.kind}`)
            )}
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <Button
            type="submit"
            form={`${id}-form`}
            disabled={pending || !issueDate}
            aria-busy={pending || undefined}
          >
            {tc("submit")}
          </Button>
          <AlertDialogCancel ref={cancelRef} disabled={pending}>
            {t("cancel")}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
