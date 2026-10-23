"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { IssueList } from "@/components/documents/issue-list";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { type ApiIssue } from "@/features/documents/editor-model";
import { compareDecimals } from "@/features/production/model";
import { fieldOfIssue, sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

interface Component {
  componentId: string;
  quantity: string;
}

export interface ProductionOrderItem {
  id: string;
  number: string;
  productId: string;
  warehouseId: string;
  quantity: string;
  status: "planned" | "completed" | "cancelled";
  plannedOn: string;
  completedOn: string | null;
  note: string | null;
  version: number;
  components: Component[];
}

export interface ProductionManagerProps {
  companyId: string;
  today: string;
  orders: ProductionOrderItem[];
  boms: { productId: string; components: Component[] }[];
  catalog: {
    products: { id: string; name: string; sku: string | null; unit: string }[];
    names: Record<string, string>;
    units: Record<string, string>;
    warehouses: { id: string; code: string; name: string; isDefault: boolean }[];
    balances: Record<string, string>;
  };
  /** production.manage — only decides which controls are shown; the API enforces it. */
  canManage: boolean;
}

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

const STATUS_TONE: Record<ProductionOrderItem["status"], BadgeTone> = {
  planned: "accent",
  completed: "success",
  cancelled: "neutral",
};

/**
 * Production page: planned and finished orders (complete or cancel planned ones), a form to plan
 * an order, and the bills of materials. Renders from the server data and refreshes it after every
 * change; the server checks stock when an order is completed.
 */
export function ProductionManager({
  companyId,
  today,
  orders,
  boms,
  catalog,
  canManage,
}: ProductionManagerProps) {
  const t = useTranslations("production");
  const router = useRouter();
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const done = (message: string) => {
    setNotice({ kind: "done", message });
    router.refresh();
  };
  const name = (id: string) => catalog.names[id] ?? "—";
  const unit = (id: string) => catalog.units[id] ?? "";
  const warehouse = (id: string) => catalog.warehouses.find((w) => w.id === id)?.code ?? "—";

  return (
    <div className="space-y-8" data-testid="production-manager">
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        stateText={() => t("outcome.notPlanned")}
      />

      {canManage ? (
        boms.length && catalog.warehouses.length ? (
          <PlanForm
            companyId={companyId}
            today={today}
            boms={boms}
            catalog={catalog}
            onDone={done}
            onNotice={setNotice}
          />
        ) : (
          <Alert tone="info">{t("planNeeds")}</Alert>
        )
      ) : null}

      <section className="space-y-3" aria-labelledby="orders-title">
        <h3 id="orders-title" className="text-sm font-semibold text-text">
          {t("orders.title")}
        </h3>
        {orders.length === 0 ? (
          <p className="text-sm text-muted" data-testid="orders-empty">
            {t("orders.empty")}
          </p>
        ) : (
          <ul className="space-y-3" data-testid="order-list">
            {orders.map((o) => (
              <OrderRow
                key={`${o.id}-${o.version}`}
                companyId={companyId}
                order={o}
                today={today}
                canManage={canManage}
                name={name}
                unit={unit}
                warehouse={warehouse}
                balances={catalog.balances}
                onDone={done}
                onNotice={setNotice}
              />
            ))}
          </ul>
        )}
      </section>

      <BomSection
        companyId={companyId}
        boms={boms}
        catalog={catalog}
        canManage={canManage}
        onDone={done}
        onNotice={setNotice}
      />
    </div>
  );
}

function OrderRow({
  companyId,
  order,
  today,
  canManage,
  name,
  unit,
  warehouse,
  balances,
  onDone,
  onNotice,
}: {
  companyId: string;
  order: ProductionOrderItem;
  today: string;
  canManage: boolean;
  name: (id: string) => string;
  unit: (id: string) => string;
  warehouse: (id: string) => string;
  balances: Record<string, string>;
  onDone: (message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
}) {
  const t = useTranslations("production");
  const [completedOn, setCompletedOn] = useState(today);
  const [pending, setPending] = useState(false);
  const [issues, setIssues] = useState<ApiIssue[]>([]);

  async function change(body: object, message: string) {
    setPending(true);
    onNotice(null);
    const outcome = await sendRecord(
      `/api/companies/${companyId}/production/orders/${order.id}`,
      "PATCH",
      { expectedVersion: order.version, ...body },
      "order",
    );
    setPending(false);
    if (outcome.kind === "ok") onDone(message);
    else {
      setIssues(outcome.kind === "invalid" ? outcome.issues : []);
      onNotice(outcome);
    }
  }

  return (
    <li
      className="space-y-3 rounded-xl border border-border p-3"
      data-testid="order-row"
      data-number={order.number}
      data-status={order.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm whitespace-nowrap text-text">{order.number}</span>
        <Badge tone={STATUS_TONE[order.status]}>{t(`status.${order.status}`)}</Badge>
        <span className="min-w-0 break-words text-text">
          {name(order.productId)} ×{" "}
          <span className="whitespace-nowrap tabular-nums">
            {order.quantity} {unit(order.productId)}
          </span>
        </span>
      </div>
      <p className="text-xs text-muted">
        {t("orders.meta", {
          warehouse: warehouse(order.warehouseId),
          planned: order.plannedOn,
        })}
        {order.completedOn ? ` · ${t("orders.completedOn", { date: order.completedOn })}` : null}
      </p>
      <ul className="space-y-1 text-sm">
        {order.components.map((c) => {
          const available = balances[`${c.componentId}:${order.warehouseId}`] ?? "0";
          const short = order.status === "planned" && compareDecimals(available, c.quantity) < 0;
          return (
            <li key={c.componentId} className="flex flex-wrap justify-between gap-2">
              <span className="min-w-0 break-words text-muted">{name(c.componentId)}</span>
              <span className="whitespace-nowrap tabular-nums">
                <span className="text-text">
                  {c.quantity} {unit(c.componentId)}
                </span>
                {order.status === "planned" ? (
                  <span className={short ? "ml-2 text-danger" : "ml-2 text-muted"}>
                    {t("orders.available", { quantity: available })}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <IssueList issues={issues} />
      {canManage && order.status === "planned" ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="sm:w-48">
            <Field
              label={t("orders.completedOnLabel")}
              name="completedOn"
              type="date"
              value={completedOn}
              onChange={(e) => setCompletedOn(e.target.value)}
            />
          </div>
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              void change(
                { action: "complete", completedOn },
                t("done.completed", { number: order.number }),
              )
            }
          >
            {t("orders.complete")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              void change({ action: "cancel" }, t("done.cancelled", { number: order.number }))
            }
          >
            {t("orders.cancel")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function PlanForm({
  companyId,
  today,
  boms,
  catalog,
  onDone,
  onNotice,
}: {
  companyId: string;
  today: string;
  boms: ProductionManagerProps["boms"];
  catalog: ProductionManagerProps["catalog"];
  onDone: (message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
}) {
  const t = useTranslations("production");
  const id = useId();
  const defaultWarehouse = (catalog.warehouses.find((w) => w.isDefault) ?? catalog.warehouses[0])
    ?.id;
  const [productId, setProductId] = useState("");
  const [warehouseId, setWarehouseId] = useState(defaultWarehouse ?? "");
  const [quantity, setQuantity] = useState("");
  const [plannedOn, setPlannedOn] = useState(today);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const bad = new Set(issues.map((i) => fieldOfIssue(i.path)));
  const withBom = boms.map((b) => b.productId);

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="production-plan"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        onNotice(null);
        const outcome = await sendRecord<ProductionOrderItem>(
          `/api/companies/${companyId}/production/orders`,
          "POST",
          { productId, warehouseId, quantity: quantity.trim(), plannedOn },
          "order",
        );
        setPending(false);
        if (outcome.kind === "ok") {
          setIssues([]);
          setQuantity("");
          onDone(t("done.planned", { number: outcome.value.number }));
        } else {
          setIssues(outcome.kind === "invalid" ? outcome.issues : []);
          onNotice(outcome);
        }
      }}
    >
      <h3 className="text-sm font-semibold text-text">{t("plan.title")}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-product`} className="block text-sm font-medium text-text">
            {t("plan.product")}
          </label>
          <select
            id={`${id}-product`}
            name="productId"
            required
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            aria-invalid={bad.has("productId") || undefined}
            className={selectClass}
          >
            <option value="">{t("plan.chooseProduct")}</option>
            {catalog.products
              .filter((p) => withBom.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku ? `${p.name} (${p.sku})` : p.name}
                </option>
              ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-warehouse`} className="block text-sm font-medium text-text">
            {t("plan.warehouse")}
          </label>
          <select
            id={`${id}-warehouse`}
            name="warehouseId"
            required
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className={selectClass}
          >
            {catalog.warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
        </div>
        <Field
          label={`${t("plan.quantity")}${productId ? ` (${catalog.units[productId] ?? ""})` : ""}`}
          name="quantity"
          required
          inputMode="decimal"
          maxLength={24}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          aria-invalid={bad.has("quantity") || undefined}
          className={bad.has("quantity") ? "border-red-500" : undefined}
        />
        <Field
          label={t("plan.plannedOn")}
          name="plannedOn"
          type="date"
          required
          value={plannedOn}
          onChange={(e) => setPlannedOn(e.target.value)}
        />
      </div>
      <IssueList issues={issues} />
      <Button type="submit" disabled={pending}>
        {t("plan.submit")}
      </Button>
    </form>
  );
}

function BomSection({
  companyId,
  boms,
  catalog,
  canManage,
  onDone,
  onNotice,
}: {
  companyId: string;
  boms: ProductionManagerProps["boms"];
  catalog: ProductionManagerProps["catalog"];
  canManage: boolean;
  onDone: (message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
}) {
  const t = useTranslations("production");
  const id = useId();
  const [productId, setProductId] = useState("");
  const [rows, setRows] = useState<Component[]>([]);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const name = (pid: string) => catalog.names[pid] ?? "—";

  const edit = (pid: string) => {
    setProductId(pid);
    setRows(boms.find((b) => b.productId === pid)?.components ?? []);
    setIssues([]);
  };

  return (
    <section className="space-y-3" aria-labelledby="bom-title">
      <h3 id="bom-title" className="text-sm font-semibold text-text">
        {t("bom.title")}
      </h3>
      <p className="text-xs text-muted">{t("bom.hint")}</p>
      {boms.length ? (
        <ul className="space-y-2" data-testid="bom-list">
          {boms.map((b) => (
            <li
              key={b.productId}
              className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
              data-testid="bom-row"
            >
              <div className="min-w-0">
                <p className="font-medium break-words text-text">{name(b.productId)}</p>
                <p className="text-sm break-words text-muted">
                  {b.components
                    .map(
                      (c) =>
                        `${name(c.componentId)} × ${c.quantity} ${catalog.units[c.componentId] ?? ""}`,
                    )
                    .join(" · ")}
                </p>
              </div>
              {canManage ? (
                <Button type="button" variant="secondary" onClick={() => edit(b.productId)}>
                  {t("bom.edit")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("bom.empty")}</p>
      )}
      {canManage ? (
        <form
          className="space-y-3 rounded-xl border border-border p-4"
          data-testid="bom-editor"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            onNotice(null);
            const outcome = await sendRecord(
              `/api/companies/${companyId}/production/boms/${productId}`,
              "PUT",
              { components: rows.filter((r) => r.componentId) },
              "bom",
            );
            setPending(false);
            if (outcome.kind === "ok") {
              setIssues([]);
              onDone(t("done.bomSaved"));
            } else {
              setIssues(outcome.kind === "invalid" ? outcome.issues : []);
              onNotice(outcome);
            }
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor={`${id}-bom-product`} className="block text-sm font-medium text-text">
              {t("bom.product")}
            </label>
            <select
              id={`${id}-bom-product`}
              name="bomProductId"
              value={productId}
              onChange={(e) => edit(e.target.value)}
              className={selectClass}
            >
              <option value="">{t("plan.chooseProduct")}</option>
              {catalog.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku ? `${p.name} (${p.sku})` : p.name}
                </option>
              ))}
            </select>
          </div>
          {productId ? (
            <>
              <ol className="space-y-2">
                {rows.map((r, i) => (
                  <li key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
                    <div className="space-y-1.5">
                      <label
                        htmlFor={`${id}-c${i}`}
                        className="block text-sm font-medium text-text"
                      >
                        {t("bom.component", { n: i + 1 })}
                      </label>
                      <select
                        id={`${id}-c${i}`}
                        name={`components.${i}.componentId`}
                        value={r.componentId}
                        onChange={(e) =>
                          setRows(
                            rows.map((x, j) =>
                              j === i ? { ...x, componentId: e.target.value } : x,
                            ),
                          )
                        }
                        className={selectClass}
                      >
                        <option value="">{t("bom.chooseComponent")}</option>
                        {catalog.products
                          .filter((p) => p.id !== productId)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.sku ? `${p.name} (${p.sku})` : p.name}
                            </option>
                          ))}
                      </select>
                    </div>
                    <Field
                      label={t("bom.quantity")}
                      name={`components.${i}.quantity`}
                      inputMode="decimal"
                      maxLength={24}
                      value={r.quantity}
                      onChange={(e) =>
                        setRows(
                          rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    >
                      {t("bom.remove")}
                    </Button>
                  </li>
                ))}
              </ol>
              <IssueList issues={issues} />
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setRows([...rows, { componentId: "", quantity: "1" }])}
                >
                  {t("bom.addComponent")}
                </Button>
                <Button type="submit" disabled={pending}>
                  {t("bom.save")}
                </Button>
              </div>
            </>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
