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
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Alert, Button } from "@/components/ui/form";
import { interpretRecordResponse } from "@/features/records/api";
import { type AppLocale, LOCALE_FORMAT_TAGS } from "@/i18n/config";
import { useRouter } from "@/i18n/navigation";
import { type SubscriptionPhase } from "@/modules/billing/access";

export interface BillingData {
  configured: boolean;
  enforced: boolean;
  hasCustomer: boolean;
  plan: string | null;
  status: string | null;
  phase: SubscriptionPhase;
  access: "full" | "read_only";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  grantExpiresAt: string | null;
  priceEur: string;
}

export interface BillingInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amount: string;
  currency: string;
  created: string;
  url: string | null;
}

const PHASE_TONE: Record<SubscriptionPhase, BadgeTone> = {
  active: "success",
  past_due: "warning",
  awaiting_payment: "warning",
  payment_required: "danger",
  ended: "neutral",
  none: "neutral",
};

const FEATURES = [
  "dashboard",
  "documents",
  "finance",
  "catalog",
  "costing",
  "ai",
  "team",
  "languages",
] as const;

/**
 * The company's one subscription: price, Stripe's current status, what happens in each state,
 * and buttons that open Stripe-hosted pages (Checkout to subscribe, the customer portal to change
 * the card), plus cancel/resume of the renewal and the billing history. The server decides
 * everything; this only shows the answer and follows the returned URL.
 */
export function BillingPanel({
  companyId,
  billing,
  invoices,
  checkout,
}: {
  companyId: string;
  billing: BillingData;
  invoices: BillingInvoice[] | null;
  checkout: "success" | "cancelled" | null;
}) {
  const t = useTranslations("billing");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const [failed, setFailed] = useState(false);
  const tag = LOCALE_FORMAT_TAGS[locale];
  const date = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso))
      : "";
  const money = (amount: string, currency: string) =>
    new Intl.NumberFormat(tag, { style: "currency", currency }).format(
      amount as Intl.StringNumericLiteral,
    );
  const live = ["active", "past_due", "awaiting_payment", "payment_required"].includes(
    billing.phase,
  );

  async function post(path: "checkout" | "portal" | "renewal", body: object) {
    setPending(true);
    setNotice(null);
    setFailed(false);
    try {
      const res = await fetch(`/api/companies/${companyId}/billing/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(path === "renewal" ? body : { ...body, locale }),
      });
      const json = (await res.json().catch(() => null)) as { url?: string } | null;
      if (res.ok && json?.url) {
        window.location.assign(json.url);
        return;
      }
      if (res.ok && path === "renewal") {
        setNotice({ kind: "done", message: t("renewal.saved") });
        router.refresh();
      } else if (res.status === 502) setFailed(true);
      else {
        const outcome = interpretRecordResponse(res.status, json, "url");
        setNotice(outcome.kind === "ok" ? { kind: "error" } : outcome);
      }
    } catch {
      setNotice({ kind: "error" });
    }
    setPending(false);
  }

  if (!billing.configured)
    return (
      <div className="space-y-4">
        <Alert tone="info">
          <span data-testid="billing-not-configured">{t("notConfigured")}</span>
        </Alert>
        <PlanCard price={billing.priceEur} />
      </div>
    );

  return (
    <div className="space-y-6" data-testid="billing-panel">
      {checkout === "success" ? (
        <Alert tone="success">
          <span data-testid="billing-checkout-success">{t("checkout.success")}</span>
        </Alert>
      ) : null}
      {checkout === "cancelled" ? <Alert tone="info">{t("checkout.cancelled")}</Alert> : null}
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        stateText={(code) =>
          t.has(`state.${code}` as Parameters<typeof t>[0])
            ? t(`state.${code}` as Parameters<typeof t>[0])
            : t("state.billing.failed")
        }
      />
      {failed ? <Alert tone="error">{t("state.billing.failed")}</Alert> : null}

      <section className="space-y-3" aria-labelledby="billing-current">
        <h3 id="billing-current" className="text-sm font-semibold text-text">
          {t("current")}
        </h3>
        <div className="space-y-2" data-testid="billing-current" data-phase={billing.phase}>
          <p className="flex flex-wrap items-center gap-2 text-text">
            <span className="font-medium">{t("planName")}</span>
            <Badge tone={PHASE_TONE[billing.phase]}>{t(`phase.${billing.phase}.label`)}</Badge>
          </p>
          <p className="text-sm text-muted">{t(`phase.${billing.phase}.text`)}</p>
          {billing.phase === "active" && billing.currentPeriodEnd ? (
            <p className="text-sm text-muted">
              {billing.cancelAtPeriodEnd
                ? t("endsOn", { date: date(billing.currentPeriodEnd) })
                : t("renewsOn", { date: date(billing.currentPeriodEnd) })}
            </p>
          ) : null}
          {billing.enforced && billing.access === "read_only" ? (
            <Alert tone="warning">
              <span data-testid="billing-read-only">{t("readOnly")}</span>
            </Alert>
          ) : null}
          {billing.grantExpiresAt ? (
            <p className="text-sm text-muted">
              {t("grantUntil", { date: date(billing.grantExpiresAt) })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {live ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => void post("portal", {})}
              data-testid="billing-portal"
            >
              {t("manage")}
            </Button>
          ) : null}
          {live && billing.phase !== "awaiting_payment" ? (
            billing.cancelAtPeriodEnd ? (
              <Button
                type="button"
                disabled={pending}
                onClick={() => void post("renewal", { cancel: false })}
                data-testid="billing-resume"
              >
                {t("renewal.resume")}
              </Button>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button type="button" variant="danger" disabled={pending} />}
                  data-testid="billing-cancel"
                >
                  {t("renewal.cancel")}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogTitle className="text-base font-semibold">
                    {t("renewal.confirmTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-sm text-muted">
                    {t("renewal.confirmText", { date: date(billing.currentPeriodEnd) })}
                  </AlertDialogDescription>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("renewal.keep")}</AlertDialogCancel>
                    <AlertDialogCancel
                      variant="danger"
                      onClick={() => void post("renewal", { cancel: true })}
                      data-testid="billing-cancel-confirm"
                    >
                      {t("renewal.confirm")}
                    </AlertDialogCancel>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )
          ) : null}
        </div>
      </section>

      {!live ? (
        <section className="space-y-3" aria-labelledby="billing-plan">
          <h3 id="billing-plan" className="text-sm font-semibold text-text">
            {t("subscribeTitle")}
          </h3>
          <PlanCard price={billing.priceEur}>
            <Button
              type="button"
              disabled={pending}
              onClick={() => void post("checkout", {})}
              data-testid="billing-subscribe"
            >
              {t("subscribe", { price: billing.priceEur })}
            </Button>
          </PlanCard>
        </section>
      ) : null}

      {billing.hasCustomer ? (
        <section className="space-y-3" aria-labelledby="billing-history">
          <h3 id="billing-history" className="text-sm font-semibold text-text">
            {t("history")}
          </h3>
          {invoices === null ? (
            <p className="text-sm text-muted">{t("historyUnavailable")}</p>
          ) : invoices.length === 0 ? (
            <p className="text-sm text-muted">{t("historyEmpty")}</p>
          ) : (
            <ul
              className="divide-y divide-border rounded-xl border border-border"
              data-testid="billing-invoices"
            >
              {invoices.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="text-muted tabular-nums">{date(inv.created)}</span>
                  <span className="text-text">{inv.number ?? "—"}</span>
                  <span className="ml-auto font-medium text-text tabular-nums">
                    {money(inv.amount, inv.currency)}
                  </span>
                  <Badge
                    tone={
                      inv.status === "paid"
                        ? "success"
                        : inv.status === "open"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {t.has(`invoiceStatus.${inv.status}` as Parameters<typeof t>[0])
                      ? t(`invoiceStatus.${inv.status}` as Parameters<typeof t>[0])
                      : (inv.status ?? "—")}
                  </Badge>
                  {inv.url ? (
                    <a
                      href={inv.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      {t("viewInvoice")}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** The one plan: price and what it includes. */
function PlanCard({ price, children }: { price: string; children?: ReactNode }) {
  const t = useTranslations("billing");
  const tf = useTranslations("pricing.features");
  return (
    <div className="flex flex-col gap-4 rounded-2xl p-5 surface-raised" data-testid="billing-plan">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-semibold text-text">{t("planName")}</p>
          <p className="text-sm text-muted">{t("planText")}</p>
        </div>
        <p className="text-3xl font-semibold text-text tabular-nums">
          €{price}
          <span className="text-sm font-normal text-muted"> {t("perMonth")}</span>
        </p>
      </div>
      <ul className="grid gap-2 text-sm text-text sm:grid-cols-2">
        {FEATURES.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="mt-0.5 size-4 shrink-0 text-accent"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="m5 12 5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {tf(f)}
          </li>
        ))}
      </ul>
      {children}
      <p className="text-xs text-muted">{t("pricesNote")}</p>
    </div>
  );
}
