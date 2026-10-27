"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
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
import { sendRecord } from "@/features/records/api";
import { type AppLocale, LOCALE_FORMAT_TAGS } from "@/i18n/config";
import { useRouter } from "@/i18n/navigation";
import {
  calculateCost,
  type CalculationResult,
  COST_CATEGORIES,
  type CostCategory,
} from "@/modules/costing/domain/calculate";

type Basis = "total" | "per_unit" | "piecework" | "percent";

interface LineDraft {
  key: number;
  category: CostCategory;
  label: string;
  basis: Basis;
  amount: string;
  pieces: string;
  verified: boolean;
}

interface Draft {
  name: string;
  productId: string;
  currency: "EUR" | "PLN";
  quantity: string;
  salePrice: string;
  targetMarginPercent: string;
  lines: LineDraft[];
  scenarios: { key: number; label: string; quantity: string; salePrice: string }[];
}

export interface SavedCalculation {
  id: string;
  name: string;
  productId: string | null;
  productName: string | null;
  currency: "EUR" | "PLN";
  input: {
    currency: "EUR" | "PLN";
    quantity: string;
    lines: {
      category: CostCategory;
      label: string;
      basis: Basis;
      amount: string;
      pieces?: string | null;
      verified?: boolean;
    }[];
    salePrice?: string | null;
    targetMarginPercent?: string | null;
    scenarios: { label: string; quantity: string; salePrice?: string | null }[];
  };
  result: CalculationResult;
  version: number;
  updatedAt: string;
}

const DEFAULT_BASIS: Record<CostCategory, Basis> = {
  purchase: "per_unit",
  delivery: "total",
  insurance: "total",
  customs_duty: "percent",
  non_recoverable_tax: "total",
  packaging: "per_unit",
  materials: "per_unit",
  labor: "total",
  piecework: "piecework",
  overhead: "total",
  other: "total",
};

let nextKey = 1;
const newLine = (category: CostCategory): LineDraft => ({
  key: nextKey++,
  category,
  label: "",
  basis: DEFAULT_BASIS[category],
  amount: "",
  pieces: "",
  verified: false,
});

const emptyDraft = (): Draft => ({
  name: "",
  productId: "",
  currency: "EUR",
  quantity: "1",
  salePrice: "",
  targetMarginPercent: "",
  lines: [newLine("purchase"), newLine("delivery")],
  scenarios: [],
});

const draftOf = (c: SavedCalculation): Draft => ({
  name: c.name,
  productId: c.productId ?? "",
  currency: c.input.currency,
  quantity: c.input.quantity,
  salePrice: c.input.salePrice ?? "",
  targetMarginPercent: c.input.targetMarginPercent ?? "",
  lines: c.input.lines.map((l) => ({
    key: nextKey++,
    category: l.category,
    label: l.label,
    basis: l.basis,
    amount: l.amount,
    pieces: l.pieces ?? "",
    verified: Boolean(l.verified),
  })),
  scenarios: c.input.scenarios.map((s) => ({
    key: nextKey++,
    label: s.label,
    quantity: s.quantity,
    salePrice: s.salePrice ?? "",
  })),
});

const toInput = (d: Draft) => ({
  currency: d.currency,
  quantity: d.quantity,
  lines: d.lines
    .filter((l) => l.amount.trim() !== "")
    .map((l) => ({
      category: l.category,
      label: l.label,
      basis: l.basis,
      amount: l.amount,
      ...(l.basis === "piecework" && l.pieces.trim() ? { pieces: l.pieces } : {}),
      ...(l.basis === "percent" ? { verified: l.verified } : {}),
    })),
  salePrice: d.salePrice.trim() || null,
  targetMarginPercent: d.targetMarginPercent.trim() || null,
  scenarios: d.scenarios
    .filter((s) => s.quantity.trim())
    .map((s) => ({ label: s.label, quantity: s.quantity, salePrice: s.salePrice.trim() || null })),
});

const inputClass =
  "w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-sm text-text focus:border-accent focus:outline-none";

/**
 * The cost calculator: cost lines for one batch, live results computed in the browser with the
 * same decimal code the server uses, and saving (the server recomputes and stores its own result).
 * Duty and tax rates are always typed in by the user and flagged until marked verified.
 */
export function CostCalculator({
  companyId,
  saved,
  products,
  canManage,
}: {
  companyId: string;
  saved: SavedCalculation[];
  products: { id: string; name: string }[];
  canManage: boolean;
}) {
  const t = useTranslations("costing");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<{ id: string; version: number } | null>(null);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const [pending, setPending] = useState(false);
  const url = `/api/companies/${companyId}/costing`;
  const tag = LOCALE_FORMAT_TAGS[locale];

  const live = useMemo((): { result: CalculationResult | null; invalid: boolean } => {
    try {
      return { result: calculateCost(toInput(draft)), invalid: false };
    } catch {
      return { result: null, invalid: true };
    }
  }, [draft]);

  const money = (v: string, digits = 2) =>
    new Intl.NumberFormat(tag, {
      style: "currency",
      currency: draft.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v as Intl.StringNumericLiteral);
  const setLine = (key: number, patch: Partial<LineDraft>) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    }));

  async function save() {
    setPending(true);
    setNotice(null);
    const body = {
      name: draft.name,
      productId: draft.productId || null,
      calculation: toInput(draft),
    };
    const outcome = editing
      ? await sendRecord<SavedCalculation>(
          `${url}/${editing.id}`,
          "PUT",
          { ...body, expectedVersion: editing.version },
          "calculation",
        )
      : await sendRecord<SavedCalculation>(url, "POST", body, "calculation");
    setPending(false);
    if (outcome.kind === "ok") {
      setEditing({ id: outcome.value.id, version: outcome.value.version });
      setNotice({ kind: "done", message: t("saved") });
      router.refresh();
    } else setNotice(outcome);
  }

  async function remove(id: string) {
    const outcome = await sendRecord(`${url}/${id}`, "DELETE", {}, "deleted");
    if (outcome.kind === "ok") {
      if (editing?.id === id) {
        setEditing(null);
        setDraft(emptyDraft());
      }
      setNotice({ kind: "done", message: t("deleted") });
      router.refresh();
    } else setNotice(outcome);
  }

  const r = live.result;
  return (
    <div className="space-y-6" data-testid="cost-calculator">
      <Alert tone="info">{t("taxNote")}</Alert>
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      <RecordNotice notice={notice} onReload={() => router.refresh()} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section aria-labelledby="calc-input" className="space-y-4">
          <h3 id="calc-input" className="text-sm font-semibold text-text">
            {editing ? t("editing") : t("newCalculation")}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t("fields.name")}
              name="name"
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <div className="space-y-1.5">
              <label htmlFor="calc-product" className="block text-sm font-medium text-text">
                {t("fields.product")}
              </label>
              <select
                id="calc-product"
                className={inputClass}
                value={draft.productId}
                onChange={(e) => setDraft({ ...draft, productId: e.target.value })}
              >
                <option value="">{t("noProduct")}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label={t("fields.quantity")}
              name="quantity"
              inputMode="decimal"
              value={draft.quantity}
              hint={t("quantityHint")}
              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
            />
            <div className="space-y-1.5">
              <label htmlFor="calc-currency" className="block text-sm font-medium text-text">
                {t("fields.currency")}
              </label>
              <select
                id="calc-currency"
                className={inputClass}
                value={draft.currency}
                onChange={(e) =>
                  setDraft({ ...draft, currency: e.target.value as Draft["currency"] })
                }
              >
                <option value="EUR">EUR</option>
                <option value="PLN">PLN</option>
              </select>
            </div>
          </div>

          <ul className="space-y-2" data-testid="cost-lines">
            {draft.lines.map((l, i) => {
              const res = r?.lines.find(
                (x) => x.index === draft.lines.filter((y) => y.amount.trim() !== "").indexOf(l),
              );
              return (
                <li
                  key={l.key}
                  className="animate-fade-up rounded-xl border border-border bg-surface-2/40 p-3"
                  data-testid="cost-line"
                >
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
                    <select
                      aria-label={t("fields.category")}
                      className={inputClass}
                      value={l.category}
                      onChange={(e) =>
                        setLine(l.key, {
                          category: e.target.value as CostCategory,
                          basis: DEFAULT_BASIS[e.target.value as CostCategory],
                        })
                      }
                    >
                      {COST_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {t(`category.${c}`)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t("fields.basis")}
                      className={inputClass}
                      value={l.basis}
                      onChange={(e) => setLine(l.key, { basis: e.target.value as Basis })}
                    >
                      {(["total", "per_unit", "piecework", "percent"] as const).map((b) => (
                        <option key={b} value={b}>
                          {t(`basis.${b}`)}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={
                        l.basis === "percent"
                          ? t("fields.percent")
                          : l.basis === "piecework"
                            ? t("fields.rate")
                            : t("fields.amount")
                      }
                      className={inputClass}
                      inputMode="decimal"
                      placeholder={l.basis === "percent" ? "%" : draft.currency}
                      value={l.amount}
                      name={`amount-${i}`}
                      onChange={(e) => setLine(l.key, { amount: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      className="px-2 py-1"
                      aria-label={t("removeLine")}
                      onClick={() =>
                        setDraft((d) => ({ ...d, lines: d.lines.filter((x) => x.key !== l.key) }))
                      }
                    >
                      ×
                    </Button>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <input
                      aria-label={t("fields.label")}
                      placeholder={t("fields.label")}
                      className={inputClass}
                      maxLength={120}
                      value={l.label}
                      onChange={(e) => setLine(l.key, { label: e.target.value })}
                    />
                    {l.basis === "piecework" ? (
                      <input
                        aria-label={t("fields.pieces")}
                        placeholder={t("piecesPlaceholder")}
                        className={inputClass}
                        inputMode="decimal"
                        value={l.pieces}
                        onChange={(e) => setLine(l.key, { pieces: e.target.value })}
                      />
                    ) : l.basis === "percent" ? (
                      <label className="flex items-center gap-2 text-xs text-text">
                        <input
                          type="checkbox"
                          checked={l.verified}
                          onChange={(e) => setLine(l.key, { verified: e.target.checked })}
                        />
                        {t("verified")}
                      </label>
                    ) : null}
                  </div>
                  {res ? (
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted tabular-nums">
                      <span>{money(res.total)}</span>
                      <span>· {t("perUnitShort", { amount: money(res.perUnit, 4) })}</span>
                      <span>· {res.share} %</span>
                      {res.needsVerification ? (
                        <Badge tone="warning">{t("needsVerification")}</Badge>
                      ) : null}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            {(
              [
                "purchase",
                "delivery",
                "insurance",
                "customs_duty",
                "packaging",
                "materials",
                "piecework",
                "overhead",
                "other",
              ] as const
            ).map((c) => (
              <Button
                key={c}
                type="button"
                variant="secondary"
                className="px-3 py-1.5 text-xs"
                onClick={() => setDraft((d) => ({ ...d, lines: [...d.lines, newLine(c)] }))}
              >
                + {t(`category.${c}`)}
              </Button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t("fields.salePrice", { currency: draft.currency })}
              name="salePrice"
              inputMode="decimal"
              value={draft.salePrice}
              hint={t("salePriceHint")}
              onChange={(e) => setDraft({ ...draft, salePrice: e.target.value })}
            />
            <Field
              label={t("fields.targetMargin")}
              name="targetMarginPercent"
              inputMode="decimal"
              value={draft.targetMarginPercent}
              onChange={(e) => setDraft({ ...draft, targetMarginPercent: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-text">{t("scenarios")}</h4>
            {draft.scenarios.map((s) => (
              <div
                key={s.key}
                className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_auto]"
              >
                <input
                  aria-label={t("fields.scenarioLabel")}
                  placeholder={t("fields.scenarioLabel")}
                  className={inputClass}
                  value={s.label}
                  maxLength={60}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      scenarios: d.scenarios.map((x) =>
                        x.key === s.key ? { ...x, label: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <input
                  aria-label={t("fields.quantity")}
                  placeholder={t("fields.quantity")}
                  className={inputClass}
                  inputMode="decimal"
                  value={s.quantity}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      scenarios: d.scenarios.map((x) =>
                        x.key === s.key ? { ...x, quantity: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <input
                  aria-label={t("fields.salePrice", { currency: draft.currency })}
                  placeholder={t("fields.price")}
                  className={inputClass}
                  inputMode="decimal"
                  value={s.salePrice}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      scenarios: d.scenarios.map((x) =>
                        x.key === s.key ? { ...x, salePrice: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="px-2 py-1"
                  aria-label={t("removeScenario")}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      scenarios: d.scenarios.filter((x) => x.key !== s.key),
                    }))
                  }
                >
                  ×
                </Button>
              </div>
            ))}
            {draft.scenarios.length < 6 ? (
              <Button
                type="button"
                variant="secondary"
                className="px-3 py-1.5 text-xs"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    scenarios: [
                      ...d.scenarios,
                      { key: nextKey++, label: "", quantity: "", salePrice: "" },
                    ],
                  }))
                }
              >
                + {t("addScenario")}
              </Button>
            ) : null}
          </div>
        </section>

        <section
          aria-labelledby="calc-result"
          aria-live="polite"
          className="h-fit space-y-4 rounded-2xl p-5 surface-raised xl:sticky xl:top-20"
          data-testid="cost-result"
        >
          <h3 id="calc-result" className="text-sm font-semibold text-text">
            {t("result")}
          </h3>
          {live.invalid || !r ? (
            <p className="text-sm text-warning">{t("invalid")}</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-surface-2 p-3">
                  <dt className="text-xs text-muted">{t("totalCost")}</dt>
                  <dd
                    className="text-xl font-semibold text-text tabular-nums"
                    data-testid="cost-total"
                  >
                    {money(r.totalCost)}
                  </dd>
                </div>
                <div className="rounded-xl bg-surface-2 p-3">
                  <dt className="text-xs text-muted">{t("unitCost")}</dt>
                  <dd
                    className="text-xl font-semibold text-text tabular-nums glow-accent"
                    data-testid="cost-unit"
                  >
                    {money(r.unitCost, 4)}
                  </dd>
                </div>
              </dl>
              {r.byCategory.length ? (
                <ul className="space-y-1.5" aria-label={t("breakdown")}>
                  {r.byCategory.map((c) => (
                    <li
                      key={c.category}
                      className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs"
                    >
                      <span className="truncate text-muted">{t(`category.${c.category}`)}</span>
                      <span
                        className="h-2 overflow-hidden rounded-full bg-surface-2"
                        aria-hidden="true"
                      >
                        <span
                          className="block h-full rounded-full transition-[width] duration-300"
                          style={{ width: `${c.share}%`, background: "var(--color-series-1)" }}
                        />
                      </span>
                      <span className="text-text tabular-nums">{money(c.total)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {r.pricing ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm" data-testid="cost-pricing">
                  <dt className="text-muted">{t("profitPerUnit")}</dt>
                  <dd
                    className={`text-right tabular-nums ${r.pricing.profitPerUnit.startsWith("-") ? "text-danger" : "text-text"}`}
                  >
                    {money(r.pricing.profitPerUnit, 4)}
                  </dd>
                  <dt className="text-muted">{t("margin")}</dt>
                  <dd className="text-right text-text tabular-nums" data-testid="cost-margin">
                    {r.pricing.marginPercent ?? "—"} %
                  </dd>
                  <dt className="text-muted">{t("markup")}</dt>
                  <dd className="text-right text-text tabular-nums" data-testid="cost-markup">
                    {r.pricing.markupPercent ?? "—"} %
                  </dd>
                  <dt className="text-muted">{t("expectedProfit")}</dt>
                  <dd className="text-right font-medium text-text tabular-nums">
                    {money(r.pricing.expectedProfit)}
                  </dd>
                </dl>
              ) : (
                <p className="text-xs text-muted">{t("noPrice")}</p>
              )}
              {r.priceForTargetMargin ? (
                <p className="text-sm text-text" data-testid="cost-target-price">
                  {t("priceForMargin", {
                    percent: draft.targetMarginPercent,
                    price: money(r.priceForTargetMargin, 4),
                  })}
                </p>
              ) : null}
              {r.warnings.length ? (
                <Alert tone="warning">
                  <span data-testid="cost-warnings">
                    {[...new Set(r.warnings.map((w) => w.code))]
                      .map((c) => t(`warning.${c}`))
                      .join(" ")}
                  </span>
                </Alert>
              ) : null}
              {r.scenarios.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs tabular-nums">
                    <caption className="mb-1 text-left text-sm font-medium text-text">
                      {t("scenarios")}
                    </caption>
                    <thead className="text-muted">
                      <tr>
                        <th scope="col" className="py-1 text-left font-medium">
                          {t("fields.scenarioLabel")}
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          {t("fields.quantity")}
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          {t("unitCost")}
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          {t("margin")}
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          {t("expectedProfit")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.scenarios.map((s, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="py-1 text-text">{s.label || `#${i + 1}`}</td>
                          <td className="py-1 text-right text-text">{s.quantity}</td>
                          <td className="py-1 text-right text-text">{money(s.unitCost, 4)}</td>
                          <td className="py-1 text-right text-text">
                            {s.pricing?.marginPercent ?? "—"} %
                          </td>
                          <td className="py-1 text-right text-text">
                            {s.pricing ? money(s.pricing.expectedProfit) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
          {canManage ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                disabled={pending || live.invalid || !draft.name.trim()}
                onClick={() => void save()}
                data-testid="cost-save"
              >
                {editing ? t("saveChanges") : t("save")}
              </Button>
              {editing ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setEditing(null);
                    setDraft(emptyDraft());
                  }}
                >
                  {t("new")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {!draft.name.trim() && canManage ? (
            <p className="text-xs text-muted">{t("nameNeeded")}</p>
          ) : null}
        </section>
      </div>

      <section aria-labelledby="calc-saved" className="space-y-3">
        <h3 id="calc-saved" className="text-sm font-semibold text-text">
          {t("savedTitle")}
        </h3>
        {saved.length === 0 ? (
          <p className="text-sm text-muted" data-testid="costing-empty">
            {t("savedEmpty")}
          </p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2" data-testid="costing-saved">
            {saved.map((c) => (
              <li
                key={c.id}
                className="animate-fade-up rounded-xl border border-border bg-surface-2/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words text-text">{c.name}</p>
                    <p className="text-xs text-muted">
                      {c.productName ? `${c.productName} · ` : ""}
                      {t("savedFigures", {
                        quantity: c.result.quantity,
                        unit: new Intl.NumberFormat(tag, {
                          style: "currency",
                          currency: c.currency,
                          maximumFractionDigits: 4,
                        }).format(c.result.unitCost as Intl.StringNumericLiteral),
                      })}
                    </p>
                  </div>
                  {c.result.warnings.length ? (
                    <Badge tone="warning">{t("needsVerification")}</Badge>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  <Button
                    type="button"
                    variant="secondary"
                    className="px-3 py-1.5"
                    onClick={() => {
                      setDraft(draftOf(c));
                      setEditing({ id: c.id, version: c.version });
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  >
                    {t("open")}
                  </Button>
                  <a
                    href={`${url}/${c.id}/csv`}
                    className="inline-flex items-center px-2 text-accent hover:underline"
                  >
                    {t("exportCsv")}
                  </a>
                  {canManage ? (
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            className="px-2 py-1.5 text-danger"
                          />
                        }
                      >
                        {t("delete")}
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogTitle className="text-base font-semibold">
                          {t("deleteTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-sm text-muted">
                          {t("deleteText", { name: c.name })}
                        </AlertDialogDescription>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                          <AlertDialogCancel variant="danger" onClick={() => void remove(c.id)}>
                            {t("delete")}
                          </AlertDialogCancel>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
