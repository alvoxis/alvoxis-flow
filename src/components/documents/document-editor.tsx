"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { DeleteDraftButton } from "@/components/documents/delete-draft-button";
import { Totals } from "@/components/documents/document-view";
import { IssueList } from "@/components/documents/issue-list";
import { Alert, Button, Field } from "@/components/ui/form";
import {
  type ApiDocument,
  type ApiIssue,
  type ApiOutcome,
  type CategoryOption,
  chooseCategory,
  hasErrorAt,
  interpretResponse,
  legacySnapshots,
  lineTaxState,
  newLine,
  restoreLegacy,
  toDraftInput,
} from "@/features/documents/editor-model";
import { Link, useRouter } from "@/i18n/navigation";
import {
  type DocumentDraft,
  type DocumentLine,
  isPricedDocument,
  type PartySnapshot,
} from "@/modules/documents/domain/types";

export interface DocumentEditorProps {
  companyId: string;
  document: ApiDocument;
  canEdit: boolean;
  canIssue: boolean;
  /** Active company tax categories offered on lines (never a default). */
  taxCategories: CategoryOption[];
  /** May add categories in the catalog (decides which empty-catalog hint is shown). */
  canManageTaxCategories: boolean;
}

type Notice =
  { kind: "saved" | "invalid" | "issueBlocked" } | Exclude<ApiOutcome, { kind: "ok" | "invalid" }>;

async function send(url: string, method: string, body: unknown): Promise<ApiOutcome> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return interpretResponse(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "error" };
  }
}

/**
 * Draft editor over the document API (PATCH to save, POST …/issue to issue). The server is the
 * only authority on access, validation, totals and numbering; this component just shows its
 * answers. Remount it (key = version) to load a newer server version.
 */
export function DocumentEditor({
  companyId,
  document,
  canEdit,
  canIssue,
  taxCategories,
  canManageTaxCategories,
}: DocumentEditorProps) {
  const t = useTranslations("documents");
  const tPdf = useTranslations("documentPdf");
  const tCompany = useTranslations("company");
  const tCat = useTranslations("taxCategories");
  const router = useRouter();
  const confirmId = useId();
  const [draft, setDraft] = useState<DocumentDraft>(document.draft);
  const [version, setVersion] = useState(document.version);
  const [issues, setIssues] = useState<ApiIssue[]>(document.issues);
  const [totals, setTotals] = useState(document.totals);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Pre-catalog tax data as last saved, so a line can be put back before the next save.
  const [legacy, setLegacy] = useState(() => legacySnapshots(document.draft.lines));

  const url = `/api/companies/${companyId}/documents/${document.id}`;
  const priced = isPricedDocument(draft.type);
  // Credit-note lines map to invoice lines by position, so their set of lines is fixed.
  const fixedLines = draft.type === "credit_note";
  // New lines never get a category automatically; priced ones need an explicit choice.
  const canAddLines = canEdit && !fixedLines;
  const choosesCategories = priced && !fixedLines;
  const readOnly = !canEdit || pending;

  const update = (patch: Partial<DocumentDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
    setNotice(null);
  };
  const updateBuyer = (patch: Partial<PartySnapshot>) =>
    update({ buyer: { ...draft.buyer, ...patch } });
  const updateAddress = (patch: Partial<NonNullable<PartySnapshot["address"]>>) =>
    updateBuyer({ address: { lines: [], ...draft.buyer.address, ...patch } });
  const updateLine = (index: number, patch: Partial<DocumentLine>) =>
    update({ lines: draft.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) });
  /** Replaces a whole line (a merge could not remove a field such as a chosen category). */
  const replaceLine = (index: number, next: DocumentLine) =>
    update({ lines: draft.lines.map((l, i) => (i === index ? next : l)) });

  function apply(outcome: ApiOutcome, onInvalid: "invalid" | "issueBlocked") {
    if (outcome.kind === "invalid") {
      setIssues(outcome.issues);
      setNotice({ kind: onInvalid });
    } else if (outcome.kind !== "ok") {
      setNotice(outcome);
    }
  }

  async function save() {
    setPending(true);
    setConfirming(false);
    const outcome = await send(url, "PATCH", {
      expectedVersion: version,
      draft: toDraftInput(draft),
    });
    setPending(false);
    if (outcome.kind === "ok") {
      setDraft(outcome.document.draft);
      setVersion(outcome.document.version);
      setIssues(outcome.document.issues);
      setTotals(outcome.document.totals);
      setLegacy(legacySnapshots(outcome.document.draft.lines));
      setDirty(false);
      setNotice({ kind: "saved" });
      return;
    }
    apply(outcome, "invalid");
  }

  async function issue() {
    setPending(true);
    const outcome = await send(`${url}/issue`, "POST", { expectedVersion: version });
    setPending(false);
    setConfirming(false);
    // The page re-renders from the server and shows the issued, read-only document.
    if (outcome.kind === "ok") return router.refresh();
    apply(outcome, "issueBlocked");
  }

  const text = (
    label: string,
    name: string,
    value: string | undefined,
    onChange: (v: string) => void,
    opts: { invalid?: boolean; type?: string; maxLength?: number; inputMode?: "decimal" } = {},
  ) => (
    <Field
      label={label}
      name={name}
      type={opts.type ?? "text"}
      inputMode={opts.inputMode}
      value={value ?? ""}
      maxLength={opts.maxLength}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={opts.invalid || undefined}
      className={opts.invalid ? "border-red-500" : undefined}
    />
  );

  const area = (label: string, name: "paymentTerms" | "notes", max: number) => (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-text">{label}</span>
      <textarea
        name={name}
        value={draft[name] ?? ""}
        maxLength={max}
        rows={2}
        readOnly={readOnly}
        onChange={(e) => update({ [name]: e.target.value })}
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none"
      />
    </label>
  );

  const err = (field: string, line?: number) => hasErrorAt(issues, field, line);

  const optionText = (c: Pick<CategoryOption, "label" | "code" | "kind" | "ratePercent">) =>
    `${c.label} · ${c.code} · ${c.kind === "standard" ? `${c.ratePercent}%` : tCat(`kind.${c.kind}`)}`;

  /** Category picker and its warnings for one line of an invoice or proforma. */
  const lineTax = (line: DocumentLine, i: number) => {
    const state = lineTaxState(line, taxCategories);
    const previous = legacy.get(line.id);
    const invalid = err("lines.taxCategory", i) || err("lines.taxCategoryId", i);
    return (
      <div className="mt-3 space-y-2" data-testid="line-tax" data-state={state}>
        <label className="block space-y-1.5">
          <span className="block text-sm font-medium text-text">{t("taxCategory")}</span>
          <select
            name={`lines.${i}.taxCategoryId`}
            value={line.taxCategoryId ?? ""}
            disabled={readOnly}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              const chosen = taxCategories.find((c) => c.id === e.target.value);
              if (chosen) replaceLine(i, chooseCategory(line, chosen));
            }}
            className={`w-full rounded-lg border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none ${invalid ? "border-red-500" : "border-border"}`}
          >
            <option value="" disabled>
              {t("chooseTaxCategory")}
            </option>
            {taxCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {optionText(c)}
              </option>
            ))}
            {state === "archived" && line.taxCategory ? (
              <option value={line.taxCategoryId} disabled>
                {t("archivedOption", { name: optionText(line.taxCategory) })}
              </option>
            ) : null}
          </select>
        </label>
        {state === "archived" ? <Alert tone="warning">{t("archivedWarning")}</Alert> : null}
        {state === "legacy" && line.taxCategory ? (
          <div data-testid="legacy-warning">
            <Alert tone="warning">
              {t("legacyWarning", { details: optionText(line.taxCategory) })}
            </Alert>
          </div>
        ) : null}
        {previous && state !== "legacy" && canEdit ? (
          <Button
            type="button"
            variant="ghost"
            className="px-0 py-1"
            disabled={pending}
            onClick={() => replaceLine(i, restoreLegacy(line, previous))}
          >
            {t("restoreLegacy")}
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <form
      className="space-y-6"
      data-testid="document-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (canEdit && !pending) void save();
      }}
    >
      {!canEdit ? <Alert tone="info">{t("readOnlyDraft")}</Alert> : null}

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-text">{t("sections.dates")}</legend>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {text(tPdf("issueDate"), "issueDate", draft.issueDate, (v) => update({ issueDate: v }), {
            type: "date",
            invalid: err("issueDate"),
          })}
          {priced
            ? text(tPdf("dueDate"), "dueDate", draft.dueDate, (v) => update({ dueDate: v }), {
                type: "date",
                invalid: err("dueDate"),
              })
            : null}
          {text(
            tPdf("supplyDate"),
            "supplyDate",
            draft.supplyDate,
            (v) => update({ supplyDate: v }),
            {
              type: "date",
              invalid: err("supplyDate"),
            },
          )}
          {draft.type === "proforma"
            ? text(
                tPdf("validUntil"),
                "validUntil",
                draft.validUntil,
                (v) => update({ validUntil: v }),
                {
                  type: "date",
                  invalid: err("validUntil"),
                },
              )
            : null}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-text">{t("sections.buyer")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {text(t("name"), "buyer.name", draft.buyer.name, (v) => updateBuyer({ name: v }), {
            maxLength: 300,
            invalid: err("buyer.name"),
          })}
          {text(
            tPdf("registrationNumber"),
            "buyer.registrationNumber",
            draft.buyer.registrationNumber,
            (v) => updateBuyer({ registrationNumber: v }),
            { maxLength: 50, invalid: err("buyer.registrationNumber") },
          )}
          {text(
            tPdf("vatNumber"),
            "buyer.vatNumber",
            draft.buyer.vatNumber,
            (v) => updateBuyer({ vatNumber: v }),
            {
              maxLength: 50,
              invalid: err("buyer.vatNumber"),
            },
          )}
          {text(tPdf("email"), "buyer.email", draft.buyer.email, (v) => updateBuyer({ email: v }), {
            type: "email",
            maxLength: 254,
            invalid: err("buyer.email"),
          })}
          {text(
            t("addressLine"),
            "buyer.address.line1",
            draft.buyer.address?.lines[0],
            (v) => updateAddress({ lines: [v, ...(draft.buyer.address?.lines.slice(1) ?? [])] }),
            { maxLength: 200, invalid: err("buyer.address") },
          )}
          {text(
            tCompany("postalCode"),
            "buyer.address.postalCode",
            draft.buyer.address?.postalCode,
            (v) => updateAddress({ postalCode: v }),
          )}
          {text(tCompany("city"), "buyer.address.city", draft.buyer.address?.city, (v) =>
            updateAddress({ city: v }),
          )}
          {text(
            t("countryCode"),
            "buyer.address.countryCode",
            draft.buyer.address?.countryCode,
            (v) => updateAddress({ countryCode: v }),
            { maxLength: 2, invalid: err("buyer.address.countryCode") },
          )}
        </div>
        <p className="text-xs text-muted">{t("sellerHint")}</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-text">{t("sections.lines")}</legend>
        {choosesCategories && taxCategories.length === 0 ? (
          <div data-testid="no-tax-categories">
            <Alert tone="warning">
              {canManageTaxCategories ? (
                <>
                  {t("noCategoriesManage")}{" "}
                  <Link href={`/companies/${companyId}/tax-categories`} className="underline">
                    {t("setUpCategories")}
                  </Link>
                </>
              ) : (
                t("noCategoriesAsk")
              )}
            </Alert>
          </div>
        ) : null}
        <ol className="space-y-3">
          {draft.lines.map((line, i) => (
            <li
              key={line.id}
              className="rounded-xl border border-border p-3"
              data-testid="document-line"
            >
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
                <span>{t("lineN", { n: i + 1 })}</span>
                <span>
                  {fixedLines && line.taxCategory
                    ? `${line.taxCategory.label} · ${t("creditNoteTax")}`
                    : null}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
                {text(
                  tPdf("description"),
                  `lines.${i}.description`,
                  line.description,
                  (v) => updateLine(i, { description: v }),
                  { maxLength: 1000, invalid: err("lines.description", i) },
                )}
                {text(
                  tPdf("quantity"),
                  `lines.${i}.quantity`,
                  line.quantity,
                  (v) => updateLine(i, { quantity: v }),
                  {
                    inputMode: "decimal",
                    invalid: err("lines.quantity", i),
                  },
                )}
                {text(
                  tPdf("unit"),
                  `lines.${i}.unit`,
                  line.unit,
                  (v) => updateLine(i, { unit: v }),
                  {
                    maxLength: 20,
                  },
                )}
                {priced
                  ? text(
                      tPdf("unitPrice"),
                      `lines.${i}.unitPrice`,
                      line.unitPrice ?? "",
                      (v) => updateLine(i, { unitPrice: v }),
                      { inputMode: "decimal", invalid: err("lines.unitPrice", i) },
                    )
                  : null}
                {priced
                  ? text(
                      tPdf("discount"),
                      `lines.${i}.discountPercent`,
                      line.discountPercent,
                      (v) => updateLine(i, { discountPercent: v }),
                      { inputMode: "decimal", invalid: err("lines.discountPercent", i) },
                    )
                  : null}
              </div>
              {choosesCategories ? lineTax(line, i) : null}
              {canEdit && !fixedLines ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-2 px-0 py-1"
                  disabled={pending}
                  onClick={() => update({ lines: draft.lines.filter((_, j) => j !== i) })}
                >
                  {t("removeLine", { n: i + 1 })}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
        {canAddLines ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => update({ lines: [...draft.lines, newLine(crypto.randomUUID())] })}
          >
            {t("addLine")}
          </Button>
        ) : null}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-text">{t("sections.other")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {text(
            tPdf("buyerReference"),
            "buyerReference",
            draft.buyerReference,
            (v) => update({ buyerReference: v }),
            { maxLength: 200 },
          )}
          {priced ? area(tPdf("paymentTerms"), "paymentTerms", 500) : null}
          {area(tPdf("notes"), "notes", 2000)}
        </div>
      </fieldset>

      {priced ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-text">{t("sections.totals")}</h3>
          {totals && !dirty ? (
            <Totals totals={totals} currency={draft.currency} />
          ) : (
            <p className="text-sm text-muted">{t("totalsPending")}</p>
          )}
        </section>
      ) : null}

      <IssueList issues={issues} />

      <NoticeAlert notice={notice} onReload={() => router.refresh()} />
      {dirty && canIssue ? <Alert tone="warning">{t("unsaved")}</Alert> : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {canEdit ? (
          <Button type="submit" disabled={pending || !dirty}>
            {t("save")}
          </Button>
        ) : null}
        {canIssue && !confirming ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending || dirty}
            onClick={() => {
              setNotice(null);
              setConfirming(true);
            }}
          >
            {t("issue")}
          </Button>
        ) : null}
      </div>

      {canEdit ? (
        <div className="border-t border-border pt-4">
          <DeleteDraftButton companyId={companyId} documentId={document.id} />
        </div>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby={`${confirmId}-title`}
          aria-describedby={`${confirmId}-body`}
          className="space-y-3 rounded-xl border border-accent/50 bg-accent-soft/40 p-4"
          data-testid="issue-confirm"
        >
          <p id={`${confirmId}-title`} className="text-sm font-semibold text-text">
            {t("issueConfirmTitle")}
          </p>
          <p id={`${confirmId}-body`} className="text-sm text-muted">
            {t("issueConfirmBody")}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="button" disabled={pending} onClick={() => void issue()}>
              {t("issueConfirm")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

function NoticeAlert({ notice, onReload }: { notice: Notice | null; onReload: () => void }) {
  const t = useTranslations("documents");
  const tCompany = useTranslations("company");
  if (!notice) return null;
  switch (notice.kind) {
    case "saved":
      return <Alert tone="success">{t("saved")}</Alert>;
    case "invalid":
      return <Alert tone="error">{t("invalid")}</Alert>;
    case "issueBlocked":
      return <Alert tone="error">{t("issueBlocked")}</Alert>;
    case "conflict":
    case "notDraft":
      return (
        <Alert tone="error">
          {t(`outcome.${notice.kind}`)}{" "}
          <button type="button" className="underline" onClick={onReload}>
            {t("reload")}
          </button>
        </Alert>
      );
    case "twoFactor":
      return (
        <Alert tone="error">
          {t("outcome.twoFactor")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      );
    default:
      return <Alert tone="error">{t(`outcome.${notice.kind}`)}</Alert>;
  }
}
