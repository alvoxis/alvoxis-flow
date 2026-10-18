"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { BankAccountSelect } from "@/components/documents/bank-account-select";
import { IssueList } from "@/components/documents/issue-list";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { type BankAccountItem } from "@/features/bank-accounts/model";
import { type ApiIssue } from "@/features/documents/editor-model";
import {
  findingsToCheck,
  IMPORT_DOCUMENT_TYPES,
  type ImportForm,
  type ImportOutcome,
  type ImportProblem,
  importFormProblems,
  initialImportForm,
  interpretImportResponse,
  MAX_UPLOAD_BYTES,
  needsDuplicateConfirmation,
  toImportDecisions,
} from "@/features/documents/import-model";
import { type AppLocale, LOCALE_ENDONYMS, LOCALES } from "@/i18n/config";
import { Link, useRouter } from "@/i18n/navigation";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { type ImportReview } from "@/modules/documents/import/review";

const selectClass =
  "w-full min-h-11 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:opacity-60";
const MAX_MB = MAX_UPLOAD_BYTES / 1024 / 1024;

type Notice =
  Exclude<ImportOutcome, { kind: "review" | "created" | "invalid" }> | { kind: "noFile" };

async function post(url: string, body: FormData): Promise<ImportOutcome> {
  try {
    const res = await fetch(url, { method: "POST", body });
    return interpretImportResponse(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "error" };
  }
}

/**
 * Imports one PDF invoice of the company: (1) the file is read on the server and the extracted
 * fields come back for review, nothing is created; (2) the user checks every finding, the buyer,
 * dates, lines and chooses the tax category explicitly; (3) the same file is sent again with these
 * decisions, the server reads it again and creates a DRAFT, which opens in the editor. The file is
 * processed in memory and never stored. The seller is always the company itself.
 */
export function PdfImport({
  companyId,
  companyName,
  taxCategories,
  bankAccounts,
}: {
  companyId: string;
  companyName: string;
  taxCategories: { id: string; label: string; code: string }[];
  bankAccounts: BankAccountItem[];
}) {
  const t = useTranslations("documents.import");
  const tDocs = useTranslations("documents");
  const tPdf = useTranslations("documentPdf");
  const tCompany = useTranslations("company");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [form, setForm] = useState<ImportForm | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [problems, setProblems] = useState<ImportProblem[]>([]);
  const base = `/api/companies/${companyId}/documents/import`;

  function startOver() {
    setFile(null);
    setReview(null);
    setForm(null);
    setNotice(null);
    setIssues([]);
    setProblems([]);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function read() {
    if (inFlight.current) return;
    setNotice(null);
    if (!file) return setNotice({ kind: "noFile" });
    if (file.size > MAX_UPLOAD_BYTES) return setNotice({ kind: "tooLarge" });
    inFlight.current = true;
    setPending(true);
    const body = new FormData();
    body.set("file", file);
    const outcome = await post(`${base}/preview`, body);
    inFlight.current = false;
    setPending(false);
    if (outcome.kind === "review") {
      setReview(outcome.review);
      setForm(
        initialImportForm(outcome.review, {
          language: locale,
          bankAccountId: bankAccounts.find((a) => a.isDefault)?.id ?? "",
        }),
      );
      return;
    }
    if (outcome.kind !== "created" && outcome.kind !== "invalid") setNotice(outcome);
  }

  async function create() {
    if (inFlight.current || !file || !review || !form) return;
    const found = importFormProblems(form, review);
    setProblems(found);
    setIssues([]);
    setNotice(null);
    if (found.length) return;
    inFlight.current = true;
    setPending(true);
    const body = new FormData();
    body.set("file", file);
    body.set("decisions", JSON.stringify(toImportDecisions(form, companyName)));
    const outcome = await post(base, body);
    if (outcome.kind === "created") {
      // Stays locked while the browser opens the new draft.
      router.push(`/companies/${companyId}/documents/${outcome.documentId}`);
      return;
    }
    inFlight.current = false;
    setPending(false);
    if (outcome.kind === "invalid") setIssues(outcome.issues);
    else if (outcome.kind !== "review") setNotice(outcome);
  }

  const set = (patch: Partial<ImportForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setLine = (i: number, patch: Partial<ImportForm["lines"][number]>) =>
    setForm((f) =>
      f ? { ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : f,
    );
  const flagText = (code: string) =>
    t.has(`flags.${code}` as Parameters<typeof t>[0])
      ? t(`flags.${code}` as Parameters<typeof t>[0])
      : t("flags.generic");

  const noticeAlert = notice ? (
    <Alert tone="error">
      <span data-testid="import-notice">
        {notice.kind === "noFile"
          ? t("noFile")
          : notice.kind === "tooLarge"
            ? t("tooLarge", { size: MAX_MB })
            : notice.kind === "file"
              ? t(notice.code === "import.file.notPdf" ? "notPdf" : "unreadable")
              : notice.kind === "twoFactor"
                ? tDocs("outcome.twoFactor")
                : tDocs(`outcome.${notice.kind}`)}
      </span>{" "}
      {notice.kind === "twoFactor" ? (
        <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
      ) : null}
    </Alert>
  ) : null;

  if (!review || !form) {
    return (
      <form
        className="space-y-4"
        data-testid="import-upload"
        onSubmit={(e) => {
          e.preventDefault();
          void read();
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor={`${id}-file`} className="block text-sm font-medium text-text">
            {t("fileLabel")}
          </label>
          <input
            id={`${id}-file`}
            ref={fileRef}
            type="file"
            name="file"
            accept="application/pdf,.pdf"
            disabled={pending}
            aria-describedby={`${id}-file-hint`}
            onChange={(e) => {
              setNotice(null);
              setFile(e.target.files?.[0] ?? null);
            }}
            className="block w-full rounded-lg border border-border bg-surface-2 text-sm text-text file:mr-3 file:min-h-11 file:border-0 file:bg-surface file:px-4 file:text-sm file:text-text"
          />
          <p id={`${id}-file-hint`} className="text-xs text-muted">
            {t("fileHint", { size: MAX_MB })}
          </p>
        </div>
        <p className="text-xs text-muted">{t("privacy")}</p>
        {noticeAlert}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
            {pending ? t("reading") : t("read")}
          </Button>
          <Link
            href={`/companies/${companyId}/documents`}
            className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm text-violet-300 hover:underline"
          >
            {tDocs("cancel")}
          </Link>
        </div>
      </form>
    );
  }

  const toCheck = review.flags.filter((f) => f.severity !== "info");
  const infos = review.flags.filter((f) => f.severity === "info");
  const problem = (p: ImportProblem) => problems.includes(p);

  return (
    <form
      className="space-y-6"
      data-testid="import-review"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span data-testid="import-file">
          {t("fileRead", { name: file?.name ?? "", pages: review.pageCount })}
        </span>
        <button
          type="button"
          className="min-h-11 text-violet-300 hover:underline"
          onClick={startOver}
          disabled={pending}
        >
          {t("startOver")}
        </button>
      </div>

      {toCheck.length || infos.length ? (
        <section
          aria-labelledby={`${id}-findings`}
          className="space-y-2"
          data-testid="import-findings"
        >
          <h3 id={`${id}-findings`} className="text-sm font-semibold text-text">
            {t("findingsTitle")}
          </h3>
          {toCheck.length ? <p className="text-xs text-muted">{t("findingsHint")}</p> : null}
          <ul className="space-y-2">
            {findingsToCheck(review).map((code) => {
              const severity = toCheck.find((f) => f.code === code)!.severity as
                "error" | "warning";
              return (
                <li
                  key={code}
                  className={`rounded-lg border px-3 py-2 ${problem("findings") && !form.acknowledged.includes(code) ? "border-red-500" : "border-border"}`}
                  data-testid="import-finding"
                  data-code={code}
                >
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-violet-500"
                      checked={form.acknowledged.includes(code)}
                      onChange={(e) =>
                        set({
                          acknowledged: e.target.checked
                            ? [...form.acknowledged, code]
                            : form.acknowledged.filter((c) => c !== code),
                        })
                      }
                    />
                    <span className="min-w-0 space-y-1">
                      <Badge tone={severity === "error" ? "danger" : "warning"}>
                        {tDocs(`severity.${severity}`)}
                      </Badge>{" "}
                      <span className="text-text">{flagText(code)}</span>
                      <span className="block text-xs text-muted">{t("checked")}</span>
                    </span>
                  </label>
                </li>
              );
            })}
            {infos.map((f) => (
              <li
                key={f.code}
                className="rounded-lg border border-border px-3 py-2 text-sm text-muted"
                data-testid="import-finding"
                data-code={f.code}
              >
                {flagText(f.code)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {review.duplicates.length ? (
        <section className="space-y-2" data-testid="import-duplicates">
          <Alert tone="warning">
            <span className="block font-medium">{t("duplicatesTitle")}</span>
            <ul className="mt-1 list-disc pl-5">
              {review.duplicates.map((d) => (
                <li key={d.documentId}>
                  <Link
                    href={`/companies/${companyId}/documents/${d.documentId}`}
                    className="underline"
                  >
                    {d.number ?? tDocs("notIssued")}
                  </Link>{" "}
                  ({t(`duplicateStrength.${d.strength}`)})
                </li>
              ))}
            </ul>
          </Alert>
          {needsDuplicateConfirmation(review) ? (
            <label
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm text-text ${problem("duplicates") && !form.acknowledgedDuplicates ? "border-red-500" : "border-border"}`}
            >
              <input
                type="checkbox"
                className="mt-1 accent-violet-500"
                checked={form.acknowledgedDuplicates}
                onChange={(e) => set({ acknowledgedDuplicates: e.target.checked })}
              />
              <span>{t("duplicateConfirm")}</span>
            </label>
          ) : null}
        </section>
      ) : null}

      <fieldset className="space-y-3" disabled={pending}>
        <legend className="mb-1 text-sm font-semibold text-text">{t("documentTitle")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5" htmlFor={`${id}-type`}>
            <span className="block text-sm font-medium text-text">{tDocs("new.type")}</span>
            <select
              id={`${id}-type`}
              value={form.type}
              onChange={(e) => set({ type: e.target.value as ImportForm["type"] })}
              className={selectClass}
            >
              {IMPORT_DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {tPdf(`title.${type}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5" htmlFor={`${id}-language`}>
            <span className="block text-sm font-medium text-text">{tDocs("new.language")}</span>
            <select
              id={`${id}-language`}
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
            <span className="block text-sm font-medium text-text">{tDocs("new.currency")}</span>
            <select
              id={`${id}-currency`}
              value={form.currency}
              aria-invalid={problem("currency") && !form.currency ? true : undefined}
              onChange={(e) => set({ currency: e.target.value as ImportForm["currency"] })}
              className={selectClass}
            >
              <option value="" disabled>
                {tDocs("new.chooseCurrency")}
              </option>
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <Field
            label={tPdf("number")}
            name="number"
            value={review.number.value ?? ""}
            readOnly
            hint={t("numberHint")}
          />
          <Field
            label={tPdf("issueDate")}
            name="issueDate"
            type="date"
            value={form.issueDate}
            aria-invalid={problem("issueDate") ? true : undefined}
            onChange={(e) => set({ issueDate: e.target.value })}
          />
          <Field
            label={tPdf("dueDate")}
            name="dueDate"
            type="date"
            value={form.dueDate}
            onChange={(e) => set({ dueDate: e.target.value })}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-3" disabled={pending}>
        <legend className="mb-1 text-sm font-semibold text-text">{t("partiesTitle")}</legend>
        <p className="text-sm text-text">{t("sellerFixed", { name: companyName })}</p>
        {review.seller.name.value ? (
          <p className="text-xs text-muted">
            {t("sellerRead", { name: review.seller.name.value })}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t("buyerName")}
            name="buyerName"
            value={form.buyerName}
            maxLength={300}
            aria-invalid={problem("buyerName") && !form.buyerName.trim() ? true : undefined}
            onChange={(e) => set({ buyerName: e.target.value })}
          />
          <Field
            label={t("buyerRegistrationNumber")}
            name="buyerRegistrationNumber"
            value={form.buyerRegistrationNumber}
            maxLength={50}
            onChange={(e) => set({ buyerRegistrationNumber: e.target.value })}
          />
          <Field
            label={t("buyerVatNumber")}
            name="buyerVatNumber"
            value={form.buyerVatNumber}
            maxLength={50}
            onChange={(e) => set({ buyerVatNumber: e.target.value })}
          />
          <Field
            label={tPdf("buyerReference")}
            name="buyerReference"
            value={form.buyerReference}
            maxLength={200}
            onChange={(e) => set({ buyerReference: e.target.value })}
          />
          <Field
            label={tPdf("paymentTerms")}
            name="paymentTerms"
            value={form.paymentTerms}
            maxLength={500}
            onChange={(e) => set({ paymentTerms: e.target.value })}
          />
          {form.type !== "delivery_note" ? (
            <BankAccountSelect
              companyId={companyId}
              accounts={bankAccounts}
              value={form.bankAccountId}
              onChange={(bankAccountId) => set({ bankAccountId })}
            />
          ) : null}
        </div>
      </fieldset>

      <fieldset className="space-y-3" disabled={pending}>
        <legend className="mb-1 text-sm font-semibold text-text">{t("taxTitle")}</legend>
        <p className="text-xs text-muted">{t("taxHint")}</p>
        {taxCategories.length ? (
          <label className="block max-w-md space-y-1.5" htmlFor={`${id}-tax`}>
            <span className="block text-sm font-medium text-text">{t("taxCategory")}</span>
            <select
              id={`${id}-tax`}
              value={form.defaultTaxCategoryId}
              aria-invalid={problem("taxCategory") && !form.defaultTaxCategoryId ? true : undefined}
              onChange={(e) => set({ defaultTaxCategoryId: e.target.value })}
              className={selectClass}
            >
              <option value="">{tDocs("chooseTaxCategory")}</option>
              {taxCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.code})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Alert tone="warning">
            {t("noCategories")}{" "}
            <Link href={`/companies/${companyId}/tax-categories`} className="underline">
              {tDocs("setUpCategories")}
            </Link>
          </Alert>
        )}
      </fieldset>

      <fieldset className="space-y-3" disabled={pending} data-testid="import-lines">
        <legend className="mb-1 text-sm font-semibold text-text">{t("linesTitle")}</legend>
        <ul className="space-y-3">
          {form.lines.map((l, i) => (
            <li
              key={i}
              className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[2fr_1fr_0.8fr_1fr]"
              data-testid="import-line"
            >
              <Field
                label={`${tPdf("description")} ${i + 1}`}
                name={`lines.${i}.description`}
                value={l.description}
                maxLength={1000}
                onChange={(e) => setLine(i, { description: e.target.value })}
              />
              <Field
                label={tPdf("quantity")}
                name={`lines.${i}.quantity`}
                inputMode="decimal"
                value={l.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
              />
              <Field
                label={tPdf("unit")}
                name={`lines.${i}.unit`}
                value={l.unit}
                maxLength={20}
                onChange={(e) => setLine(i, { unit: e.target.value })}
              />
              <Field
                label={tPdf("unitPrice")}
                name={`lines.${i}.unitPrice`}
                inputMode="decimal"
                value={l.unitPrice}
                hint={l.total ? t("printedTotal", { amount: l.total }) : undefined}
                onChange={(e) => setLine(i, { unitPrice: e.target.value })}
              />
              {l.flags.length ? (
                <p className="text-xs text-warning sm:col-span-4">
                  {l.flags.map((f) => flagText(f)).join(" ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        {form.lines.length === 0 ? <p className="text-sm text-muted">{t("noLines")}</p> : null}
      </fieldset>

      <section className="space-y-1 text-sm" data-testid="import-totals">
        <h3 className="text-sm font-semibold text-text">{t("totalsTitle")}</h3>
        <dl className="grid max-w-sm grid-cols-2 gap-x-4 gap-y-1 text-muted">
          <dt>{tPdf("netTotal")}</dt>
          <dd className="tabular text-right text-text">{review.totals.subtotal.value ?? "—"}</dd>
          <dt>{tPdf("taxTotal")}</dt>
          <dd className="tabular text-right text-text">{review.totals.tax.value ?? "—"}</dd>
          <dt>{tPdf("grossTotal")}</dt>
          <dd className="tabular text-right text-text">{review.totals.total.value ?? "—"}</dd>
        </dl>
        <p className="text-xs text-muted">{t("totalsHint")}</p>
      </section>

      {review.statements.length ? (
        <section className="space-y-1" data-testid="import-statements">
          <h3 className="text-sm font-semibold text-text">{t("statementsTitle")}</h3>
          <p className="text-xs text-muted">{t("statementsHint")}</p>
          <ul className="list-disc pl-5 text-sm text-text">
            {review.statements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {problems.length ? (
        <Alert tone="error">
          <span data-testid="import-problems">
            {problems.map((p) => t(`problems.${p}`)).join(" ")}
          </span>
        </Alert>
      ) : null}
      <IssueList issues={issues} />
      {noticeAlert}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          {tDocs("new.create")}
        </Button>
        <Link
          href={`/companies/${companyId}/documents`}
          className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm text-violet-300 hover:underline"
        >
          {tDocs("cancel")}
        </Link>
      </div>
    </form>
  );
}
