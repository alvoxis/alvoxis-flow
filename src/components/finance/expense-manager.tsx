"use client";

import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { fieldOfIssue, orNull, sendRecord } from "@/features/records/api";
import { type AppLocale } from "@/i18n/config";
import { Link, useRouter } from "@/i18n/navigation";
import { formatDate, formatMoney } from "@/lib/format";
import { type CurrencyCode } from "@/lib/money";
import {
  EXPENSE_CATEGORIES,
  nextOccurrence,
  PAYMENT_METHODS,
  RECURRENCES,
} from "@/modules/finance/domain/expenses";

export interface ExpenseItem {
  id: string;
  expenseDate: string;
  category: (typeof EXPENSE_CATEGORIES)[number];
  description: string;
  supplierId: string | null;
  supplierName: string | null;
  currency: CurrencyCode;
  netAmount: string;
  taxAmount: string;
  taxRecoverable: boolean;
  grossAmount: string;
  costAmount: string;
  status: "paid" | "unpaid";
  dueDate: string | null;
  paidOn: string | null;
  paymentMethod: (typeof PAYMENT_METHODS)[number] | null;
  reference: string | null;
  notes: string | null;
  recurrence: (typeof RECURRENCES)[number];
  source: string;
  overdue: boolean;
  version: number;
}

export interface ExpenseQueryState {
  q?: string;
  category?: string;
  status?: string;
  from?: string;
  to?: string;
  sort: string;
  page: number;
}

interface Draft {
  expenseDate: string;
  category: (typeof EXPENSE_CATEGORIES)[number];
  description: string;
  supplierId: string;
  supplierName: string;
  currency: CurrencyCode;
  netAmount: string;
  taxAmount: string;
  taxRecoverable: boolean;
  status: "paid" | "unpaid";
  dueDate: string;
  paidOn: string;
  paymentMethod: string;
  reference: string;
  notes: string;
  recurrence: (typeof RECURRENCES)[number];
}

const today = () => new Date().toISOString().slice(0, 10);

const emptyDraft = (): Draft => ({
  expenseDate: today(),
  category: "other",
  description: "",
  supplierId: "",
  supplierName: "",
  currency: "EUR",
  netAmount: "",
  taxAmount: "0",
  taxRecoverable: true,
  status: "paid",
  dueDate: "",
  paidOn: "",
  paymentMethod: "bank_transfer",
  reference: "",
  notes: "",
  recurrence: "none",
});

const draftOf = (e: ExpenseItem): Draft => ({
  expenseDate: e.expenseDate,
  category: e.category,
  description: e.description,
  supplierId: e.supplierId ?? "",
  supplierName: e.supplierId ? "" : (e.supplierName ?? ""),
  currency: e.currency,
  netAmount: e.netAmount,
  taxAmount: e.taxAmount,
  taxRecoverable: e.taxRecoverable,
  status: e.status,
  dueDate: e.dueDate ?? "",
  paidOn: e.paidOn ?? "",
  paymentMethod: e.paymentMethod ?? "",
  reference: e.reference ?? "",
  notes: e.notes ?? "",
  recurrence: e.recurrence,
});

const toBody = (d: Draft) => ({
  expenseDate: d.expenseDate,
  category: d.category,
  description: d.description,
  supplierId: d.supplierId || null,
  supplierName: d.supplierId ? null : orNull(d.supplierName),
  currency: d.currency,
  netAmount: d.netAmount,
  taxAmount: d.taxAmount || "0",
  taxRecoverable: d.taxRecoverable,
  status: d.status,
  dueDate: orNull(d.dueDate),
  paidOn: d.status === "paid" ? orNull(d.paidOn) : null,
  paymentMethod: d.paymentMethod ? (d.paymentMethod as Draft["paymentMethod"]) : null,
  reference: orNull(d.reference),
  notes: orNull(d.notes),
  recurrence: d.recurrence,
});

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

function Select({
  label,
  value,
  onChange,
  children,
  name,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  children: ReactNode;
  name?: string;
}) {
  const id = `sel-${name ?? label}`.replace(/\s+/g, "-");
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
      </label>
      <select
        id={id}
        name={name}
        className={selectClass}
        value={onChange ? value : undefined}
        defaultValue={onChange ? undefined : value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      >
        {children}
      </select>
    </div>
  );
}

/**
 * Expenses of a company: server-side search, filters, sorting and paging (the URL holds the
 * query), CSV export of the filtered list, and add/edit/delete through the API. Every amount comes
 * from the server; nothing is calculated here except formatting.
 */
export function ExpenseManager({
  companyId,
  expenses,
  total,
  pageSize,
  query,
  canManage,
  suppliers,
}: {
  companyId: string;
  expenses: ExpenseItem[];
  total: number;
  pageSize: number;
  query: ExpenseQueryState;
  canManage: boolean;
  suppliers: { id: string; name: string }[];
}) {
  const t = useTranslations("finance");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [editing, setEditing] = useState<{
    id: string | null;
    draft: Draft;
    version?: number;
  } | null>(null);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const url = `/api/companies/${companyId}/expenses`;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const qs = (over: Partial<ExpenseQueryState>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...over }))
      if (
        v !== undefined &&
        v !== "" &&
        !(k === "page" && v === 1) &&
        !(k === "sort" && v === "date_desc")
      )
        p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const exportQs = (() => {
    const p = new URLSearchParams();
    for (const k of ["q", "category", "status", "from", "to"] as const)
      if (query[k]) p.set(k, query[k]!);
    const s = p.toString();
    return s ? `?${s}` : "";
  })();

  async function remove(id: string) {
    const outcome = await sendRecord(`${url}/${id}`, "DELETE", {}, "deleted");
    if (outcome.kind === "ok") {
      setNotice({ kind: "done", message: t("done.deleted") });
      router.refresh();
    } else setNotice(outcome);
  }

  return (
    <div className="space-y-5" data-testid="expense-manager">
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      <RecordNotice notice={notice} onReload={() => router.refresh()} />

      <form
        method="get"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
        data-testid="expense-filters"
      >
        <div className="sm:col-span-2">
          <Field
            label={t("search")}
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            placeholder={t("searchPlaceholder")}
          />
        </div>
        <Select label={t("fields.category")} name="category" value={query.category ?? ""}>
          <option value="">{t("all")}</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`category.${c}`)}
            </option>
          ))}
        </Select>
        <Select label={t("fields.status")} name="status" value={query.status ?? ""}>
          <option value="">{t("all")}</option>
          <option value="paid">{t("status.paid")}</option>
          <option value="unpaid">{t("status.unpaid")}</option>
        </Select>
        <Field label={t("from")} name="from" type="date" defaultValue={query.from ?? ""} />
        <Field label={t("to")} name="to" type="date" defaultValue={query.to ?? ""} />
        <Select label={t("sort.label")} name="sort" value={query.sort}>
          {(["date_desc", "date_asc", "amount_desc", "amount_asc"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`sort.${s}`)}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit" variant="secondary">
            {t("apply")}
          </Button>
          <Link
            href={`/companies/${companyId}/finance`}
            className="px-2 py-2.5 text-sm text-muted hover:text-text"
          >
            {t("reset")}
          </Link>
          <a
            href={`${url}/export${exportQs}`}
            className="px-2 py-2.5 text-sm text-accent hover:underline"
            data-testid="expense-export"
          >
            {t("export")}
          </a>
          {canManage && !editing ? (
            <Button
              type="button"
              className="ml-auto"
              onClick={() => setEditing({ id: null, draft: emptyDraft() })}
              data-testid="expense-add"
            >
              {t("add")}
            </Button>
          ) : null}
        </div>
      </form>

      {editing ? (
        <ExpenseForm
          key={editing.id ?? "new"}
          title={editing.id ? t("edit") : t("add")}
          initial={editing.draft}
          suppliers={suppliers}
          onCancel={() => setEditing(null)}
          onSubmit={async (draft) => {
            const outcome = editing.id
              ? await sendRecord(
                  `${url}/${editing.id}`,
                  "PUT",
                  { ...toBody(draft), expectedVersion: editing.version },
                  "expense",
                )
              : await sendRecord(url, "POST", toBody(draft), "expense");
            if (outcome.kind === "ok") {
              setEditing(null);
              setNotice({
                kind: "done",
                message: editing.id ? t("done.updated") : t("done.created"),
              });
              router.refresh();
            } else setNotice(outcome);
            return outcome;
          }}
        />
      ) : null}

      <p className="text-sm text-muted" data-testid="expense-count">
        {t("count", { count: total })}
      </p>
      {expenses.length === 0 ? (
        <div
          className="animate-fade-up rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted"
          data-testid="expenses-empty"
        >
          {query.q || query.category || query.status || query.from || query.to
            ? t("noMatches")
            : t("empty")}
        </div>
      ) : (
        <ul className="space-y-2" data-testid="expense-list">
          {expenses.map((e, i) => (
            <li
              key={e.id}
              style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}
              className="animate-fade-up rounded-xl border border-border bg-surface-2/40 p-3 sm:p-4"
              data-testid="expense-row"
            >
              <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words text-text">{e.description}</p>
                  <p className="text-xs text-muted">
                    {formatDate(e.expenseDate, locale)} · {t(`category.${e.category}`)}
                    {e.supplierName ? ` · ${e.supplierName}` : ""}
                    {e.reference ? ` · ${e.reference}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-text tabular-nums">
                    {formatMoney(e.grossAmount, e.currency, locale)}
                  </p>
                  <p className="text-xs text-muted tabular-nums">
                    {t("costShort", { amount: formatMoney(e.costAmount, e.currency, locale) })}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={e.status === "paid" ? "success" : e.overdue ? "danger" : "warning"}>
                  {e.status === "paid"
                    ? t("status.paid")
                    : e.overdue
                      ? t("status.overdue")
                      : t("status.unpaid")}
                </Badge>
                {e.status === "unpaid" && e.dueDate ? (
                  <span className="text-xs text-muted">
                    {t("dueOn", { date: formatDate(e.dueDate, locale) })}
                  </span>
                ) : null}
                {e.recurrence !== "none" ? (
                  <Badge tone="accent">{t(`recurrence.${e.recurrence}`)}</Badge>
                ) : null}
                {!e.taxRecoverable && e.taxAmount !== "0.00" ? (
                  <Badge>{t("taxNotRecoverable")}</Badge>
                ) : null}
                <Badge>{t(`source.${e.source === "imported" ? "imported" : "manual"}`)}</Badge>
                {canManage ? (
                  <span className="ml-auto flex gap-1">
                    {e.recurrence !== "none" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="px-2 py-1"
                        onClick={() =>
                          setEditing({
                            id: null,
                            draft: {
                              ...draftOf(e),
                              expenseDate: nextOccurrence(e.expenseDate, e.recurrence) ?? today(),
                              status: "unpaid",
                              paidOn: "",
                              dueDate: e.dueDate
                                ? (nextOccurrence(e.dueDate, e.recurrence) ?? "")
                                : "",
                              reference: "",
                            },
                          })
                        }
                      >
                        {t("recordNext")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      className="px-2 py-1"
                      onClick={() =>
                        setEditing({ id: e.id, draft: draftOf(e), version: e.version })
                      }
                      data-testid="expense-edit"
                    >
                      {t("edit")}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button type="button" variant="ghost" className="px-2 py-1 text-danger" />
                        }
                        data-testid="expense-delete"
                      >
                        {t("delete")}
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogTitle className="text-base font-semibold">
                          {t("deleteTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-sm text-muted">
                          {t("deleteText", { description: e.description })}
                        </AlertDialogDescription>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                          <AlertDialogCancel
                            variant="danger"
                            onClick={() => void remove(e.id)}
                            data-testid="expense-delete-confirm"
                          >
                            {t("delete")}
                          </AlertDialogCancel>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <nav
          aria-label={t("pagination")}
          className="flex items-center justify-between gap-2 text-sm"
        >
          {query.page > 1 ? (
            <Link
              href={`/companies/${companyId}/finance${qs({ page: query.page - 1 })}`}
              className="text-accent hover:underline"
            >
              {t("previous")}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">{t("pageOf", { page: query.page, pages })}</span>
          {query.page < pages ? (
            <Link
              href={`/companies/${companyId}/finance${qs({ page: query.page + 1 })}`}
              className="text-accent hover:underline"
            >
              {t("next")}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}

function ExpenseForm({
  title,
  initial,
  suppliers,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: Draft;
  suppliers: { id: string; name: string }[];
  onCancel: () => void;
  onSubmit: (d: Draft) => Promise<{ kind: string; issues?: { code: string; path: string }[] }>;
}) {
  const t = useTranslations("finance");
  const [d, setD] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const issue = (code: string) =>
    t.has(`issue.${code}` as Parameters<typeof t>[0])
      ? t(`issue.${code}` as Parameters<typeof t>[0])
      : t("issue.invalid");

  return (
    <form
      className="animate-fade-up space-y-4 rounded-2xl p-4 surface-raised"
      data-testid="expense-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setErrors({});
        const outcome = await onSubmit(d);
        setPending(false);
        if (outcome.kind === "invalid" && outcome.issues)
          setErrors(
            Object.fromEntries(outcome.issues.map((i) => [fieldOfIssue(i.path), issue(i.code)])),
          );
      }}
    >
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2">
          <Field
            label={t("fields.description")}
            name="description"
            required
            maxLength={300}
            value={d.description}
            hint={errors.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>
        <Field
          label={t("fields.date")}
          name="expenseDate"
          type="date"
          required
          value={d.expenseDate}
          hint={errors.expenseDate}
          onChange={(e) => set("expenseDate", e.target.value)}
        />
        <Select
          label={t("fields.category")}
          value={d.category}
          onChange={(v) => set("category", v as Draft["category"])}
          name="f-category"
        >
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`category.${c}`)}
            </option>
          ))}
        </Select>
        {suppliers.length ? (
          <Select
            label={t("fields.supplier")}
            value={d.supplierId}
            onChange={(v) => set("supplierId", v)}
            name="f-supplier"
          >
            <option value="">{t("supplierNone")}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : null}
        {!d.supplierId ? (
          <Field
            label={t("fields.supplierName")}
            name="supplierName"
            maxLength={200}
            value={d.supplierName}
            onChange={(e) => set("supplierName", e.target.value)}
          />
        ) : null}
        <Select
          label={t("fields.currency")}
          value={d.currency}
          onChange={(v) => set("currency", v as CurrencyCode)}
          name="f-currency"
        >
          <option value="EUR">EUR</option>
          <option value="PLN">PLN</option>
        </Select>
        <Field
          label={t("fields.net")}
          name="netAmount"
          inputMode="decimal"
          required
          value={d.netAmount}
          hint={errors.netAmount}
          onChange={(e) => set("netAmount", e.target.value)}
        />
        <Field
          label={t("fields.tax")}
          name="taxAmount"
          inputMode="decimal"
          value={d.taxAmount}
          hint={errors.taxAmount ?? t("taxHint")}
          onChange={(e) => set("taxAmount", e.target.value)}
        />
        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-text">
          <input
            type="checkbox"
            checked={d.taxRecoverable}
            onChange={(e) => set("taxRecoverable", e.target.checked)}
          />
          {t("fields.taxRecoverable")}
        </label>
        <Select
          label={t("fields.status")}
          value={d.status}
          onChange={(v) => set("status", v as Draft["status"])}
          name="f-status"
        >
          <option value="paid">{t("status.paid")}</option>
          <option value="unpaid">{t("status.unpaid")}</option>
        </Select>
        {d.status === "paid" ? (
          <Field
            label={t("fields.paidOn")}
            name="paidOn"
            type="date"
            value={d.paidOn}
            hint={errors.paidOn ?? t("paidOnHint")}
            onChange={(e) => set("paidOn", e.target.value)}
          />
        ) : (
          <Field
            label={t("fields.dueDate")}
            name="dueDate"
            type="date"
            value={d.dueDate}
            hint={errors.dueDate}
            onChange={(e) => set("dueDate", e.target.value)}
          />
        )}
        <Select
          label={t("fields.method")}
          value={d.paymentMethod}
          onChange={(v) => set("paymentMethod", v)}
          name="f-method"
        >
          <option value="">—</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`method.${m}`)}
            </option>
          ))}
        </Select>
        <Field
          label={t("fields.reference")}
          name="reference"
          maxLength={100}
          value={d.reference}
          onChange={(e) => set("reference", e.target.value)}
        />
        <Select
          label={t("fields.recurrence")}
          value={d.recurrence}
          onChange={(v) => set("recurrence", v as Draft["recurrence"])}
          name="f-recurrence"
        >
          {RECURRENCES.map((r) => (
            <option key={r} value={r}>
              {t(`recurrence.${r}`)}
            </option>
          ))}
        </Select>
        <div className="sm:col-span-2 lg:col-span-3">
          <Field
            label={t("fields.notes")}
            name="notes"
            maxLength={2000}
            value={d.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending} data-testid="expense-save">
          {t("save")}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
