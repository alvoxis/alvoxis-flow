"use client";

import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { IssueList } from "@/components/documents/issue-list";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { type ApiIssue, type CategoryOption } from "@/features/documents/editor-model";
import {
  EMPTY_PRODUCT,
  type ProductDraft,
  productDraftOf,
  type ProductItem,
  toProductBody,
} from "@/features/products/model";
import { fieldOfIssue, sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

export interface ProductManagerProps {
  companyId: string;
  items: ProductItem[];
  /** Active tax categories offered as a product's default. */
  categories: CategoryOption[];
  /** All categories (archived included) to name a product's current one. */
  categoryNames: Record<string, string>;
  /** products.manage — only decides which controls are shown; the API enforces it. */
  canManage: boolean;
}

const byName = (a: ProductItem, b: ProductItem) =>
  Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name);

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

/** Product and service catalog over the API: search, add, edit, archive and restore. */
export function ProductManager({
  companyId,
  items: initial,
  categories,
  categoryNames,
  canManage,
}: ProductManagerProps) {
  const t = useTranslations("products");
  const router = useRouter();
  const [items, setItems] = useState(() => [...initial].sort(byName));
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const url = `/api/companies/${companyId}/products`;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (p) =>
        (showArchived || !p.archived) &&
        (!q ||
          [p.name, p.sku, p.barcode].filter(Boolean).some((v) => v!.toLowerCase().includes(q))),
    );
  }, [items, query, showArchived]);

  const replace = (item: ProductItem) =>
    setItems((list) => [...list.filter((p) => p.id !== item.id), item].sort(byName));

  return (
    <div className="space-y-5" data-testid="product-manager">
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        takenText={() => t("outcome.skuTaken")}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field
            label={t("search")}
            name="q"
            type="search"
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 py-2 text-sm text-text">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t("showArchived")}
        </label>
        {canManage && !adding ? (
          <Button type="button" onClick={() => setAdding(true)} data-testid="product-add">
            {t("add")}
          </Button>
        ) : null}
      </div>

      {adding ? (
        <ProductForm
          title={t("add")}
          initial={EMPTY_PRODUCT}
          categories={categories}
          submitLabel={t("create")}
          onCancel={() => setAdding(false)}
          onSubmit={async (draft) => {
            const outcome = await sendRecord<ProductItem>(
              url,
              "POST",
              toProductBody(draft),
              "product",
            );
            if (outcome.kind === "ok") {
              replace(outcome.value);
              setAdding(false);
              setNotice({ kind: "done", message: t("done.created") });
            } else setNotice(outcome);
            return outcome;
          }}
        />
      ) : null}

      {visible.length === 0 ? (
        <p className="text-sm text-muted" data-testid="products-empty">
          {items.length === 0 ? t("empty") : t("noMatches")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="product-list">
          {visible.map((item) => (
            <ProductRow
              key={`${item.id}-${item.version}`}
              url={`${url}/${item.id}`}
              item={item}
              categories={categories}
              categoryName={item.taxCategoryId ? categoryNames[item.taxCategoryId] : undefined}
              canManage={canManage}
              onChanged={(next, message) => {
                replace(next);
                setNotice({ kind: "done", message });
              }}
              onNotice={setNotice}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductRow({
  url,
  item,
  categories,
  categoryName,
  canManage,
  onChanged,
  onNotice,
}: {
  url: string;
  item: ProductItem;
  categories: CategoryOption[];
  categoryName: string | undefined;
  canManage: boolean;
  onChanged: (item: ProductItem, message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
}) {
  const t = useTranslations("products");
  const confirmId = useId();
  const [mode, setMode] = useState<"view" | "edit" | "confirmArchive">("view");
  const [pending, setPending] = useState(false);

  async function patch(body: object, message: string) {
    setPending(true);
    onNotice(null);
    const outcome = await sendRecord<ProductItem>(
      url,
      "PATCH",
      { expectedVersion: item.version, ...body },
      "product",
    );
    setPending(false);
    if (outcome.kind === "ok") onChanged(outcome.value, message);
    else onNotice(outcome);
    return outcome;
  }

  const price = (v: string | null) => (v === null ? "—" : `${v} ${item.currency}`);

  return (
    <li
      className="rounded-xl border border-border p-3"
      data-testid="product-row"
      data-name={item.name}
      data-archived={item.archived}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-words text-text">{item.name}</span>
            <Badge tone="accent">{t(`kind.${item.kind}`)}</Badge>
            {item.trackStock ? <Badge tone="success">{t("tracked")}</Badge> : null}
            {item.archived ? <Badge>{t("status.archived")}</Badge> : null}
          </div>
          <p className="text-xs break-words text-muted">
            {[
              item.sku ? `${t("fields.sku")}: ${item.sku}` : "",
              `${t("fields.unit")}: ${item.unit}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt className="text-muted">{t("fields.salePrice")}</dt>
            <dd className="whitespace-nowrap text-text tabular-nums">{price(item.salePrice)}</dd>
            <dt className="text-muted">{t("fields.purchasePrice")}</dt>
            <dd className="whitespace-nowrap text-text tabular-nums">
              {price(item.purchasePrice)}
            </dd>
            <dt className="text-muted">{t("fields.taxCategoryId")}</dt>
            <dd className="min-w-0 break-words text-text">{categoryName ?? "—"}</dd>
          </dl>
        </div>
        {canManage && mode === "view" ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setMode("edit")}
            >
              {t("edit")}
            </Button>
            {item.archived ? (
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => void patch({ archived: false }, t("done.restored"))}
              >
                {t("restore")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setMode("confirmArchive")}
              >
                {t("archive")}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {mode === "edit" ? (
        <div className="mt-3">
          <ProductForm
            title={t("edit")}
            initial={productDraftOf(item)}
            categories={categories}
            submitLabel={t("save")}
            onCancel={() => setMode("view")}
            onSubmit={(draft) => patch(toProductBody(draft), t("done.saved"))}
          />
        </div>
      ) : null}

      {mode === "confirmArchive" ? (
        <div
          role="alertdialog"
          aria-labelledby={`${confirmId}-title`}
          aria-describedby={`${confirmId}-body`}
          className="mt-3 space-y-3 rounded-xl border border-accent/50 bg-accent-soft/40 p-3"
          data-testid="product-archive-confirm"
        >
          <p id={`${confirmId}-title`} className="text-sm font-semibold text-text">
            {t("archiveConfirmTitle")}
          </p>
          <p id={`${confirmId}-body`} className="text-sm text-muted">
            {t("archiveConfirmBody")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              disabled={pending}
              onClick={() => void patch({ archived: true }, t("done.archived"))}
            >
              {t("archive")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMode("view")}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function ProductForm({
  title,
  initial,
  categories,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: ProductDraft;
  categories: CategoryOption[];
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (draft: ProductDraft) => Promise<{ kind: string; issues?: ApiIssue[] }>;
}) {
  const t = useTranslations("products");
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const bad = new Set(issues.map((i) => fieldOfIssue(i.path)));
  const set = (patch: Partial<ProductDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const invalid = (name: string) => (bad.has(name) ? "border-red-500" : undefined);

  const field = (
    name: "sku" | "name" | "unit" | "barcode" | "salePrice" | "purchasePrice",
    max: number,
    extra: { wide?: boolean; decimal?: boolean; required?: boolean } = {},
  ) => (
    <div className={extra.wide ? "sm:col-span-2" : undefined}>
      <Field
        label={t(`fields.${name}`)}
        name={name}
        value={draft[name]}
        maxLength={max}
        required={extra.required}
        inputMode={extra.decimal ? "decimal" : undefined}
        onChange={(e) => set({ [name]: e.target.value })}
        aria-invalid={bad.has(name) || undefined}
        className={invalid(name)}
      />
    </div>
  );

  const select = (
    name: "kind" | "currency" | "taxCategoryId",
    options: { value: string; label: string }[],
  ) => (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-${name}`} className="block text-sm font-medium text-text">
        {t(`fields.${name}`)}
      </label>
      <select
        id={`${id}-${name}`}
        name={name}
        value={draft[name]}
        onChange={(e) => set({ [name]: e.target.value } as Partial<ProductDraft>)}
        aria-invalid={bad.has(name) || undefined}
        className={`${selectClass} ${invalid(name) ?? ""}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="product-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        const outcome = await onSubmit(draft);
        setPending(false);
        setIssues(outcome.kind === "invalid" ? (outcome.issues ?? []) : []);
      }}
    >
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", 200, { wide: true, required: true })}
        {select("kind", [
          { value: "goods", label: t("kind.goods") },
          { value: "service", label: t("kind.service") },
        ])}
        {field("sku", 50)}
        {field("unit", 20, { required: true })}
        {field("barcode", 50)}
        {select("currency", [
          { value: "EUR", label: "EUR" },
          { value: "PLN", label: "PLN" },
        ])}
        {select("taxCategoryId", [
          { value: "", label: t("noCategory") },
          ...categories.map((c) => ({ value: c.id, label: `${c.code} · ${c.label}` })),
          // Keep a current category that is no longer offered selectable as it is.
          ...(draft.taxCategoryId && !categories.some((c) => c.id === draft.taxCategoryId)
            ? [{ value: draft.taxCategoryId, label: t("archivedCategory") }]
            : []),
        ])}
        {field("salePrice", 24, { decimal: true })}
        {field("purchasePrice", 24, { decimal: true })}
        {draft.kind === "goods" ? (
          <label className="flex items-center gap-2 text-sm text-text sm:col-span-2">
            <input
              type="checkbox"
              name="trackStock"
              checked={draft.trackStock}
              onChange={(e) => set({ trackStock: e.target.checked })}
            />
            {t("fields.trackStock")}
          </label>
        ) : null}
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor={`${id}-description`} className="block text-sm font-medium text-text">
            {t("fields.description")}
          </label>
          <textarea
            id={`${id}-description`}
            name="description"
            rows={2}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            className={selectClass}
          />
        </div>
      </div>
      <IssueList issues={issues} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
