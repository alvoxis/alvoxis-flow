"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState, useSyncExternalStore } from "react";
import { BankAccountSelect } from "@/components/documents/bank-account-select";
import { IssueList } from "@/components/documents/issue-list";
import { Alert, Button, Field } from "@/components/ui/form";
import { type BankAccountItem } from "@/features/bank-accounts/model";
import {
  localToday,
  NEW_DOCUMENT_TYPES,
  type NewDocumentForm as FormValues,
  toCreateDraftBody,
} from "@/features/documents/create-model";
import {
  type ApiIssue,
  type ApiOutcome,
  interpretResponse,
} from "@/features/documents/editor-model";
import { type AppLocale, LOCALE_ENDONYMS, LOCALES } from "@/i18n/config";
import { Link, useRouter } from "@/i18n/navigation";
import { SUPPORTED_CURRENCIES } from "@/lib/money";

const noSubscription = () => () => {};

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Creates a draft with `POST …/documents` and opens it in the editor. Sends only what the user
 * chose: type, language, currency (no default), issue date and buyer name. The seller comes from
 * the company profile on the server; lines and tax categories are added in the editor. The bank
 * account (default preselected) is sent as an id; the server copies its details.
 */
export function NewDocumentForm({
  companyId,
  bankAccounts,
}: {
  companyId: string;
  /** Active company accounts, default first. */
  bankAccounts: BankAccountItem[];
}) {
  const t = useTranslations("documents");
  const tType = useTranslations("documentPdf.title");
  const tPdf = useTranslations("documentPdf");
  const tCompany = useTranslations("company");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const id = useId();
  const [form, setForm] = useState<FormValues>({
    type: "invoice",
    language: locale,
    currency: "",
    issueDate: "",
    buyerName: "",
    bankAccountId: bankAccounts.find((a) => a.isDefault)?.id ?? "",
  });
  // Until the user edits it, the date is the browser's calendar day: read on the client only
  // (the server snapshot is empty), so the server's clock or time zone never decides it.
  const today = useSyncExternalStore(noSubscription, localToday, () => "");
  const [dateEdited, setDateEdited] = useState(false);
  const issueDate = dateEdited ? form.issueDate : today;
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [notice, setNotice] = useState<Exclude<ApiOutcome, { kind: "ok" }> | null>(null);
  const [pending, setPending] = useState(false);

  const set = (patch: Partial<FormValues>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    setPending(true);
    setNotice(null);
    let outcome: ApiOutcome;
    try {
      const res = await fetch(`/api/companies/${companyId}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toCreateDraftBody({ ...form, issueDate })),
      });
      outcome = interpretResponse(res.status, await res.json().catch(() => null));
    } catch {
      outcome = { kind: "error" };
    }
    setPending(false);
    if (outcome.kind === "ok") {
      router.push(`/companies/${companyId}/documents/${outcome.document.id}`);
      return;
    }
    setIssues(outcome.kind === "invalid" ? outcome.issues : []);
    setNotice(outcome);
  }

  return (
    <form
      className="space-y-5"
      data-testid="new-document-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && form.currency) void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5" htmlFor={`${id}-type`}>
          <span className="block text-sm font-medium text-text">{t("new.type")}</span>
          <select
            id={`${id}-type`}
            name="type"
            value={form.type}
            onChange={(e) => set({ type: e.target.value as FormValues["type"] })}
            className={selectClass}
          >
            {NEW_DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {tType(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5" htmlFor={`${id}-language`}>
          <span className="block text-sm font-medium text-text">{t("new.language")}</span>
          <select
            id={`${id}-language`}
            name="language"
            value={form.language}
            onChange={(e) => set({ language: e.target.value as AppLocale })}
            className={selectClass}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_ENDONYMS[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5" htmlFor={`${id}-currency`}>
          <span className="block text-sm font-medium text-text">{t("new.currency")}</span>
          <select
            id={`${id}-currency`}
            name="currency"
            required
            value={form.currency}
            onChange={(e) => set({ currency: e.target.value as FormValues["currency"] })}
            className={selectClass}
          >
            <option value="" disabled>
              {t("new.chooseCurrency")}
            </option>
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <Field
          label={tPdf("issueDate")}
          name="issueDate"
          type="date"
          required
          value={issueDate}
          onChange={(e) => {
            setDateEdited(true);
            set({ issueDate: e.target.value });
          }}
        />
        <Field
          label={t("new.buyerName")}
          name="buyerName"
          value={form.buyerName}
          maxLength={300}
          onChange={(e) => set({ buyerName: e.target.value })}
        />
        {form.type !== "delivery_note" ? (
          <BankAccountSelect
            companyId={companyId}
            accounts={bankAccounts}
            value={form.bankAccountId ?? ""}
            onChange={(bankAccountId) => set({ bankAccountId })}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted">{t("new.hint")}</p>
      <IssueList issues={issues} />
      {notice ? (
        <Alert tone="error">
          {notice.kind === "invalid" ? (
            t("new.invalid")
          ) : notice.kind === "twoFactor" ? (
            <>
              {t("outcome.twoFactor")}{" "}
              <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
            </>
          ) : notice.kind === "conflict" ||
            notice.kind === "notDraft" ||
            notice.kind === "state" ? (
            t("outcome.state")
          ) : (
            t(`outcome.${notice.kind}`)
          )}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="submit" disabled={pending || !form.currency || !issueDate}>
          {t("new.create")}
        </Button>
        <Link
          href={`/companies/${companyId}/documents`}
          className="inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm text-accent hover:underline"
        >
          {t("cancel")}
        </Link>
      </div>
    </form>
  );
}
