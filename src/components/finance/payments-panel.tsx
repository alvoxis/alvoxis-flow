"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
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
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, Field } from "@/components/ui/form";
import { fieldOfIssue, orNull, sendRecord } from "@/features/records/api";
import { type AppLocale } from "@/i18n/config";
import { useRouter } from "@/i18n/navigation";
import { formatDate, formatMoney } from "@/lib/format";
import { type CurrencyCode } from "@/lib/money";

export interface PaymentItem {
  id: string;
  amount: string;
  currency: CurrencyCode;
  paidOn: string;
  method: "bank_transfer" | "card" | "cash" | "other";
  reference: string | null;
  note: string | null;
  voided: boolean;
}

export interface InvoicePayments {
  currency: CurrencyCode;
  grossTotal: string;
  credited: string;
  paid: string;
  balance: string;
  status: "unpaid" | "partially_paid" | "paid" | "credited";
  overdue: boolean;
  daysOverdue: number;
  dueDate: string | null;
  payments: PaymentItem[];
}

const METHODS = ["bank_transfer", "card", "cash", "other"] as const;

export const PAYMENT_STATUS_TONE: Record<InvoicePayments["status"], BadgeTone> = {
  unpaid: "warning",
  partially_paid: "accent",
  paid: "success",
  credited: "neutral",
};

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Payment status of an issued invoice and its recorded payments. Recording and voiding go to the
 * API, which recomputes the balance under a lock and refuses overpayments; this panel only shows
 * the server's answer. The invoice itself never changes.
 */
export function PaymentsPanel({
  companyId,
  documentId,
  initial,
  canRecord,
}: {
  companyId: string;
  documentId: string;
  initial: InvoicePayments;
  canRecord: boolean;
}) {
  const t = useTranslations("payments");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    amount: initial.balance,
    paidOn: today,
    method: "bank_transfer" as (typeof METHODS)[number],
    reference: "",
    note: "",
  });
  const url = `/api/companies/${companyId}/documents/${documentId}/payments`;
  const money = (v: string) => formatMoney(v, view.currency, locale);
  const open = view.status === "unpaid" || view.status === "partially_paid";

  async function record() {
    setPending(true);
    setNotice(null);
    setErrors({});
    const outcome = await sendRecord<InvoicePayments>(
      url,
      "POST",
      {
        amount: form.amount,
        paidOn: form.paidOn,
        method: form.method,
        reference: orNull(form.reference),
        note: orNull(form.note),
      },
      "payments",
    );
    setPending(false);
    if (outcome.kind === "ok") {
      setView(outcome.value);
      setForm((f) => ({ ...f, amount: outcome.value.balance, reference: "", note: "" }));
      setNotice({ kind: "done", message: t("recorded") });
      router.refresh();
    } else if (outcome.kind === "invalid") {
      setErrors(
        Object.fromEntries(
          outcome.issues.map((i) => {
            const key = `issue.${i.code}` as Parameters<typeof t>[0];
            return [fieldOfIssue(i.path), t.has(key) ? t(key) : t("issue.invalid")];
          }),
        ),
      );
      setNotice(outcome);
    } else setNotice(outcome);
  }

  async function voidPayment(id: string) {
    setPending(true);
    setNotice(null);
    const outcome = await sendRecord<InvoicePayments>(`${url}/${id}`, "DELETE", {}, "payments");
    setPending(false);
    if (outcome.kind === "ok") {
      setView(outcome.value);
      setForm((f) => ({ ...f, amount: outcome.value.balance }));
      setNotice({ kind: "done", message: t("voided") });
      router.refresh();
    } else setNotice(outcome);
  }

  return (
    <section
      aria-labelledby="payments-title"
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="payments-panel"
      data-status={view.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="payments-title" className="text-sm font-semibold text-text">
          {t("title")}
        </h3>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={PAYMENT_STATUS_TONE[view.status]}>
            <span data-testid="payment-status">{t(`status.${view.status}`)}</span>
          </Badge>
          {view.overdue ? (
            <Badge tone="danger">{t("overdueDays", { days: view.daysOverdue })}</Badge>
          ) : null}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {(
          [
            ["gross", view.grossTotal],
            ["credited", view.credited],
            ["paid", view.paid],
            ["balance", view.balance],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-lg bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">{t(`summary.${key}`)}</dt>
            <dd className="font-medium text-text tabular-nums" data-testid={`payments-${key}`}>
              {money(value)}
            </dd>
          </div>
        ))}
      </dl>
      {view.dueDate ? (
        <p className="text-xs text-muted">
          {t("dueOn", { date: formatDate(view.dueDate, locale) })}
        </p>
      ) : null}

      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        takenText={() => t("referenceTaken")}
        stateText={(code) =>
          t.has(`state.${code}` as Parameters<typeof t>[0])
            ? t(`state.${code}` as Parameters<typeof t>[0])
            : t("state.failed")
        }
      />

      {view.payments.length === 0 ? (
        <p className="text-sm text-muted">{t("none")}</p>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border"
          data-testid="payment-list"
        >
          {view.payments.map((p) => (
            <li
              key={p.id}
              className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm ${p.voided ? "opacity-60" : ""}`}
            >
              <span className="text-muted tabular-nums">{formatDate(p.paidOn, locale)}</span>
              <span className="text-text">{t(`method.${p.method}`)}</span>
              {p.reference ? <span className="text-muted">{p.reference}</span> : null}
              <span
                className={`ml-auto font-medium tabular-nums ${p.voided ? "line-through" : "text-text"}`}
              >
                {money(p.amount)}
              </span>
              {p.voided ? (
                <Badge>{t("voidedBadge")}</Badge>
              ) : canRecord ? (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        className="px-2 py-1"
                        disabled={pending}
                      />
                    }
                    data-testid="payment-void"
                  >
                    {t("void")}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogTitle className="text-base font-semibold">
                      {t("voidTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-sm text-muted">
                      {t("voidText", { amount: money(p.amount) })}
                    </AlertDialogDescription>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("keep")}</AlertDialogCancel>
                      <AlertDialogCancel
                        variant="danger"
                        onClick={() => void voidPayment(p.id)}
                        data-testid="payment-void-confirm"
                      >
                        {t("void")}
                      </AlertDialogCancel>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canRecord && open ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          data-testid="payment-form"
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
        >
          <Field
            label={t("fields.amount", { currency: view.currency })}
            name="amount"
            inputMode="decimal"
            required
            value={form.amount}
            hint={errors.amount}
            aria-invalid={errors.amount ? true : undefined}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
          />
          <Field
            label={t("fields.paidOn")}
            name="paidOn"
            type="date"
            required
            max={today}
            value={form.paidOn}
            hint={errors.paidOn}
            onChange={(e) => setForm({ ...form, paidOn: e.target.value })}
          />
          <div className="space-y-1.5">
            <label htmlFor="payment-method" className="block text-sm font-medium text-text">
              {t("fields.method")}
            </label>
            <select
              id="payment-method"
              className={selectClass}
              value={form.method}
              onChange={(e) =>
                setForm({ ...form, method: e.target.value as (typeof METHODS)[number] })
              }
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`method.${m}`)}
                </option>
              ))}
            </select>
          </div>
          <Field
            label={t("fields.reference")}
            name="reference"
            value={form.reference}
            maxLength={100}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
          />
          <div className="sm:col-span-2">
            <Field
              label={t("fields.note")}
              name="note"
              value={form.note}
              maxLength={500}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending} data-testid="payment-record">
              {t("record")}
            </Button>
          </div>
        </form>
      ) : null}
      <p className="text-xs text-muted">{t("manualNote")}</p>
    </section>
  );
}
