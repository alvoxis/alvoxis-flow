"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge } from "@/components/ui/badge";
import { Alert, Button } from "@/components/ui/form";
import { interpretRecordResponse } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";
import { type Plan } from "@/modules/billing/plans";

export interface BillingData {
  configured: boolean;
  hasCustomer: boolean;
  plan: Plan | null;
  status: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialAvailable: boolean;
}

const LIVE = new Set(["trialing", "active", "past_due", "unpaid", "incomplete", "paused"]);

/**
 * The company's subscription: current plan and status, the plans to choose from, and buttons that
 * open Stripe-hosted pages (Checkout to subscribe, the customer portal to change, pay or cancel).
 * The server decides everything; this only shows the answer and follows the returned URL.
 */
export function BillingPanel({
  companyId,
  billing,
  plans,
  trialDays,
  checkout,
}: {
  companyId: string;
  billing: BillingData;
  plans: { plan: Plan; price: string }[];
  trialDays: number;
  checkout: "success" | "cancelled" | null;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const [failed, setFailed] = useState(false);
  const live = billing.status !== null && LIVE.has(billing.status);
  const date = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

  async function go(path: "checkout" | "portal", body: object) {
    setPending(true);
    setNotice(null);
    setFailed(false);
    try {
      const res = await fetch(`/api/companies/${companyId}/billing/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, locale }),
      });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (res.ok && json?.url) {
        window.location.assign(json.url);
        return;
      }
      if (res.status === 502) setFailed(true);
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
      <Alert tone="info">
        <span data-testid="billing-not-configured">{t("notConfigured")}</span>
      </Alert>
    );

  return (
    <div className="space-y-6" data-testid="billing-panel">
      {checkout === "success" ? <Alert tone="success">{t("checkout.success")}</Alert> : null}
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

      <section className="space-y-2" aria-labelledby="billing-current">
        <h3 id="billing-current" className="text-sm font-semibold text-text">
          {t("current")}
        </h3>
        {live && billing.plan ? (
          <div className="space-y-1" data-testid="billing-current">
            <p className="flex flex-wrap items-center gap-2 text-text">
              <span className="font-medium">{t(`plans.${billing.plan}.name`)}</span>
              <Badge
                tone={
                  billing.status === "active" || billing.status === "trialing"
                    ? "accent"
                    : "warning"
                }
              >
                {t.has(`status.${billing.status}` as Parameters<typeof t>[0])
                  ? t(`status.${billing.status}` as Parameters<typeof t>[0])
                  : billing.status}
              </Badge>
            </p>
            {billing.status === "trialing" && billing.trialEndsAt ? (
              <p className="text-sm text-muted">
                {t("trialEnds", { date: date(billing.trialEndsAt) })}
              </p>
            ) : null}
            {billing.cancelAtPeriodEnd && billing.currentPeriodEnd ? (
              <p className="text-sm text-muted">
                {t("endsOn", { date: date(billing.currentPeriodEnd) })}
              </p>
            ) : billing.status === "active" && billing.currentPeriodEnd ? (
              <p className="text-sm text-muted">
                {t("renewsOn", { date: date(billing.currentPeriodEnd) })}
              </p>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => void go("portal", {})}
              data-testid="billing-portal"
            >
              {t("manage")}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted" data-testid="billing-none">
            {t("none")}
          </p>
        )}
      </section>

      {!live ? (
        <section className="space-y-3" aria-labelledby="billing-plans">
          <h3 id="billing-plans" className="text-sm font-semibold text-text">
            {t("choose")}
          </h3>
          {billing.trialAvailable ? (
            <p className="text-sm text-muted">{t("trialInfo", { days: trialDays })}</p>
          ) : null}
          <ul className="grid gap-3 md:grid-cols-3">
            {plans.map(({ plan, price }) => (
              <li
                key={plan}
                className="flex flex-col gap-3 rounded-xl border border-border p-4"
                data-testid="billing-plan"
                data-plan={plan}
              >
                <div>
                  <p className="font-semibold text-text">{t(`plans.${plan}.name`)}</p>
                  <p className="text-sm text-muted">{t(`plans.${plan}.text`)}</p>
                </div>
                <p className="text-2xl font-semibold text-text tabular-nums">
                  €{price}
                  <span className="text-sm font-normal text-muted"> {t("perMonth")}</span>
                </p>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => void go("checkout", { plan })}
                  className="mt-auto"
                >
                  {billing.trialAvailable ? t("startTrial", { days: trialDays }) : t("subscribe")}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t("pricesNote")}</p>
        </section>
      ) : null}
      {billing.hasCustomer && !live ? (
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => void go("portal", {})}
        >
          {t("history")}
        </Button>
      ) : null}
    </div>
  );
}
