"use client";

import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { IssueList } from "@/components/documents/issue-list";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { type ApiIssue } from "@/features/documents/editor-model";
import {
  emptyOperation,
  type MovementItem,
  type OperationDraft,
  type OperationKind,
  type StockLevelItem,
  stockValue,
  sumMoney,
  toOperationBody,
  type WarehouseItem,
} from "@/features/inventory/model";
import { fieldOfIssue, sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

export interface InventoryManagerProps {
  companyId: string;
  today: string;
  warehouses: WarehouseItem[];
  stock: StockLevelItem[];
  movements: MovementItem[];
  /** Names of every product in the movement list, by id. */
  productNames: Record<string, string>;
  /** inventory.manage — only decides which controls are shown; the API enforces it. */
  canManage: boolean;
}

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Warehouse page: stock per product and warehouse, a form for receipts, issues, transfers and
 * counts, the latest movements and the warehouses themselves. Renders straight from the server
 * data and refreshes it after every change.
 */
export function InventoryManager(props: InventoryManagerProps) {
  const { companyId, warehouses, stock, movements, canManage, today } = props;
  // Products offered in the operation form: active ones that track stock.
  const products = stock
    .filter((s) => s.trackStock && !s.archived)
    .map((s) => ({ id: s.productId, name: s.name, sku: s.sku, unit: s.unit }));
  const t = useTranslations("inventory");
  const router = useRouter();
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const active = warehouses.filter((w) => !w.archived);
  const names = useMemo(() => new Map(warehouses.map((w) => [w.id, w.code])), [warehouses]);

  const done = (message: string) => {
    setNotice({ kind: "done", message });
    router.refresh();
  };

  return (
    <div className="space-y-8" data-testid="inventory-manager">
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        takenText={() => t("outcome.codeTaken")}
        stateText={() => t("outcome.notEmpty")}
      />

      {active.length === 0 ? (
        <Alert tone="info">{t("noWarehouses")}</Alert>
      ) : (
        <StockSection stock={stock} warehouses={active} names={names} />
      )}

      {canManage && active.length > 0 ? (
        products.length ? (
          <OperationForm
            companyId={companyId}
            today={today}
            warehouses={active}
            products={products}
            onDone={(message) => done(message)}
            onNotice={setNotice}
          />
        ) : (
          <Alert tone="info">{t("noTrackedProducts")}</Alert>
        )
      ) : null}

      {movements.length ? (
        <section className="space-y-3" aria-labelledby="movements-title">
          <h3 id="movements-title" className="text-sm font-semibold text-text">
            {t("movements.title")}
          </h3>
          <ul className="divide-y divide-border" data-testid="movement-list">
            {movements.map((m) => (
              <li
                key={m.id}
                className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:gap-3"
                data-testid="movement-row"
                data-kind={m.kind}
              >
                <span className="shrink-0 whitespace-nowrap text-muted tabular-nums">
                  {m.occurredOn}
                </span>
                <span className="min-w-0 flex-1 break-words text-text">
                  {props.productNames[m.productId] ?? "—"}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={m.quantity.startsWith("-") ? "warning" : "success"}>
                    {t(`kind.${m.kind}`)}
                  </Badge>
                  <span className="whitespace-nowrap text-muted">{names.get(m.warehouseId)}</span>
                  <span className="whitespace-nowrap text-text tabular-nums">
                    {m.quantity.startsWith("-") ? m.quantity : `+${m.quantity}`}
                  </span>
                  {m.reference ? (
                    <span className="text-xs break-all text-muted">{m.reference}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <WarehouseSection
        companyId={companyId}
        warehouses={warehouses}
        canManage={canManage}
        onDone={done}
        onNotice={setNotice}
      />
    </div>
  );
}

function StockSection({
  stock,
  warehouses,
  names,
}: {
  stock: StockLevelItem[];
  warehouses: WarehouseItem[];
  names: Map<string, string>;
}) {
  const t = useTranslations("inventory");
  // Value at purchase price, per currency (display only).
  const totals = new Map<string, string[]>();
  for (const s of stock) {
    const v = stockValue(s.total, s.purchasePrice);
    if (v !== null) totals.set(s.currency, [...(totals.get(s.currency) ?? []), v]);
  }
  return (
    <section className="space-y-3" aria-labelledby="stock-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="stock-title" className="text-sm font-semibold text-text">
          {t("stock.title")}
        </h3>
        {totals.size ? (
          <p className="text-sm text-muted" data-testid="stock-value">
            {t("stock.value")}:{" "}
            {[...totals.entries()].map(([cur, values]) => (
              <span key={cur} className="ml-1 whitespace-nowrap text-text tabular-nums">
                {sumMoney(values)} {cur}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      {stock.length === 0 ? (
        <p className="text-sm text-muted">{t("stock.empty")}</p>
      ) : (
        <ul className="space-y-2" data-testid="stock-list">
          {stock.map((s) => {
            const value = stockValue(s.total, s.purchasePrice);
            const parts = warehouses
              .filter((w) => s.byWarehouse[w.id])
              .map((w) => `${w.code}: ${s.byWarehouse[w.id]}`);
            // Stock left in warehouses archived since (should not happen; shown for honesty).
            for (const [id, q] of Object.entries(s.byWarehouse))
              if (!warehouses.some((w) => w.id === id)) parts.push(`${names.get(id) ?? "?"}: ${q}`);
            return (
              <li
                key={s.productId}
                className="flex flex-col gap-1 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid="stock-row"
                data-name={s.name}
                data-total={s.total}
              >
                <div className="min-w-0">
                  <p className="font-medium break-words text-text">
                    {s.name}
                    {s.archived ? (
                      <span className="ml-2 text-xs text-muted">({t("archived")})</span>
                    ) : null}
                  </p>
                  <p className="text-xs break-words text-muted">
                    {[s.sku, parts.join(" · ")].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`whitespace-nowrap tabular-nums ${s.total === "0" ? "text-muted" : "text-text"}`}
                  >
                    {s.total} {s.unit}
                  </p>
                  {value !== null ? (
                    <p className="text-xs whitespace-nowrap text-muted tabular-nums">
                      {value} {s.currency}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OperationForm({
  companyId,
  today,
  warehouses,
  products,
  onDone,
  onNotice,
}: {
  companyId: string;
  today: string;
  warehouses: WarehouseItem[];
  products: { id: string; name: string; sku: string | null; unit: string }[];
  onDone: (message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
}) {
  const t = useTranslations("inventory");
  const id = useId();
  const defaultWarehouse = (warehouses.find((w) => w.isDefault) ?? warehouses[0])?.id ?? "";
  const [draft, setDraft] = useState<OperationDraft>(() => emptyOperation(today, defaultWarehouse));
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const bad = new Set(issues.map((i) => fieldOfIssue(i.path)));
  const set = (patch: Partial<OperationDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const unit = products.find((p) => p.id === draft.productId)?.unit;

  const select = (
    name: "kind" | "productId" | "warehouseId" | "toWarehouseId",
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-${name}`} className="block text-sm font-medium text-text">
        {label}
      </label>
      <select
        id={`${id}-${name}`}
        name={name}
        value={draft[name]}
        required
        onChange={(e) => set({ [name]: e.target.value } as Partial<OperationDraft>)}
        aria-invalid={bad.has(name) || undefined}
        className={`${selectClass} ${bad.has(name) ? "border-red-500" : ""}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );

  const warehouseOptions = warehouses.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }));

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="stock-operation"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        onNotice(null);
        const outcome = await sendRecord<MovementItem[]>(
          `/api/companies/${companyId}/stock/operations`,
          "POST",
          toOperationBody(draft),
          "movements",
        );
        setPending(false);
        if (outcome.kind === "ok") {
          setIssues([]);
          setDraft((d) => ({ ...emptyOperation(today, d.warehouseId), kind: d.kind }));
          onDone(outcome.value.length ? t(`done.${draft.kind}`) : t("done.countUnchanged"));
        } else {
          setIssues(outcome.kind === "invalid" ? outcome.issues : []);
          onNotice(outcome);
        }
      }}
    >
      <h3 className="text-sm font-semibold text-text">{t("operation.title")}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {select(
          "kind",
          t("operation.kind"),
          (["receipt", "issue", "transfer", "count"] as OperationKind[]).map((k) => ({
            value: k,
            label: t(`operation.kinds.${k}`),
          })),
        )}
        {select("productId", t("operation.product"), [
          { value: "", label: t("operation.chooseProduct") },
          ...products.map((p) => ({ value: p.id, label: p.sku ? `${p.name} (${p.sku})` : p.name })),
        ])}
        {select(
          "warehouseId",
          draft.kind === "transfer" ? t("operation.from") : t("operation.warehouse"),
          warehouseOptions,
        )}
        {draft.kind === "transfer"
          ? select("toWarehouseId", t("operation.to"), [
              { value: "", label: t("operation.chooseWarehouse") },
              ...warehouseOptions.filter((w) => w.value !== draft.warehouseId),
            ])
          : null}
        <Field
          label={`${draft.kind === "count" ? t("operation.counted") : t("operation.quantity")}${unit ? ` (${unit})` : ""}`}
          name="quantity"
          inputMode="decimal"
          required
          maxLength={24}
          value={draft.quantity}
          onChange={(e) => set({ quantity: e.target.value })}
          aria-invalid={bad.has("quantity") || undefined}
          className={bad.has("quantity") ? "border-red-500" : undefined}
        />
        {draft.kind === "receipt" ? (
          <Field
            label={t("operation.unitCost")}
            name="unitCost"
            inputMode="decimal"
            maxLength={24}
            value={draft.unitCost}
            onChange={(e) => set({ unitCost: e.target.value })}
            aria-invalid={bad.has("unitCost") || undefined}
          />
        ) : null}
        <Field
          label={t("operation.date")}
          name="occurredOn"
          type="date"
          required
          value={draft.occurredOn}
          onChange={(e) => set({ occurredOn: e.target.value })}
          aria-invalid={bad.has("occurredOn") || undefined}
        />
        <Field
          label={t("operation.reference")}
          name="reference"
          maxLength={100}
          value={draft.reference}
          onChange={(e) => set({ reference: e.target.value })}
        />
      </div>
      {draft.kind === "count" ? (
        <p className="text-xs text-muted">{t("operation.countHint")}</p>
      ) : null}
      <IssueList issues={issues} />
      <Button type="submit" disabled={pending}>
        {t(`operation.submit.${draft.kind}`)}
      </Button>
    </form>
  );
}

function WarehouseSection({
  companyId,
  warehouses,
  canManage,
  onDone,
  onNotice,
}: {
  companyId: string;
  warehouses: WarehouseItem[];
  canManage: boolean;
  onDone: (message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
}) {
  const t = useTranslations("inventory");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const url = `/api/companies/${companyId}/warehouses`;

  async function patch(w: WarehouseItem, body: object, message: string) {
    setPending(true);
    onNotice(null);
    const outcome = await sendRecord<WarehouseItem>(
      `${url}/${w.id}`,
      "PATCH",
      { expectedVersion: w.version, ...body },
      "warehouse",
    );
    setPending(false);
    if (outcome.kind === "ok") onDone(message);
    else onNotice(outcome);
  }

  return (
    <section className="space-y-3" aria-labelledby="warehouses-title">
      <h3 id="warehouses-title" className="text-sm font-semibold text-text">
        {t("warehouses.title")}
      </h3>
      {warehouses.length ? (
        <ul className="space-y-2" data-testid="warehouse-list">
          {warehouses.map((w) => (
            <li
              key={w.id}
              className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="warehouse-row"
              data-code={w.code}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-text">{w.code}</span>
                <span className="break-words text-text">{w.name}</span>
                {w.isDefault ? <Badge tone="accent">{t("warehouses.default")}</Badge> : null}
                {w.archived ? <Badge>{t("archived")}</Badge> : null}
              </div>
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  {!w.archived && !w.isDefault ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => void patch(w, { isDefault: true }, t("done.warehouseSaved"))}
                    >
                      {t("warehouses.makeDefault")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      void patch(
                        w,
                        { archived: !w.archived },
                        t(w.archived ? "done.warehouseRestored" : "done.warehouseArchived"),
                      )
                    }
                  >
                    {t(w.archived ? "warehouses.restore" : "warehouses.archive")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="space-y-3 rounded-xl border border-border p-4"
          data-testid="warehouse-create"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            onNotice(null);
            const outcome = await sendRecord<WarehouseItem>(
              url,
              "POST",
              { code, name },
              "warehouse",
            );
            setPending(false);
            if (outcome.kind === "ok") {
              setCode("");
              setName("");
              setIssues([]);
              onDone(t("done.warehouseCreated"));
            } else {
              setIssues(outcome.kind === "invalid" ? outcome.issues : []);
              onNotice(outcome);
            }
          }}
        >
          <h4 className="text-sm font-medium text-text">{t("warehouses.add")}</h4>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field
              label={t("warehouses.code")}
              name="code"
              required
              maxLength={20}
              autoCapitalize="characters"
              hint={t("warehouses.codeHint")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Field
              label={t("warehouses.name")}
              name="name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <IssueList issues={issues} />
          <Button type="submit" disabled={pending}>
            {t("warehouses.add")}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
