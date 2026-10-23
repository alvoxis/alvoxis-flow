import { orNull } from "@/features/records/api";

/** Client-side shapes of the inventory API; no rules here, the server decides. */

export interface WarehouseItem {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  version: number;
}

export type MovementKind =
  | "receipt"
  | "issue"
  | "adjustment"
  | "transfer_out"
  | "transfer_in"
  | "production_consume"
  | "production_output";

export interface MovementItem {
  id: string;
  productId: string;
  warehouseId: string;
  kind: MovementKind;
  quantity: string;
  unitCost: string | null;
  occurredOn: string;
  reference: string | null;
  note: string | null;
  groupId: string | null;
  createdAt: string;
}

export interface StockLevelItem {
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  currency: string;
  purchasePrice: string | null;
  trackStock: boolean;
  archived: boolean;
  total: string;
  byWarehouse: Record<string, string>;
}

export type OperationKind = "receipt" | "issue" | "transfer" | "count";

export interface OperationDraft {
  kind: OperationKind;
  productId: string;
  warehouseId: string;
  toWarehouseId: string;
  quantity: string;
  unitCost: string;
  occurredOn: string;
  reference: string;
  note: string;
}

export function emptyOperation(today: string, warehouseId = ""): OperationDraft {
  return {
    kind: "receipt",
    productId: "",
    warehouseId,
    toWarehouseId: "",
    quantity: "",
    unitCost: "",
    occurredOn: today,
    reference: "",
    note: "",
  };
}

/** Request body for POST …/stock/operations: only the fields the kind uses. */
export function toOperationBody(d: OperationDraft) {
  return {
    kind: d.kind,
    productId: d.productId,
    warehouseId: d.warehouseId,
    ...(d.kind === "transfer" ? { toWarehouseId: d.toWarehouseId } : {}),
    quantity: d.quantity.trim(),
    ...(d.kind === "receipt" ? { unitCost: orNull(d.unitCost) } : {}),
    occurredOn: d.occurredOn,
    reference: orNull(d.reference),
    note: orNull(d.note),
  };
}

/**
 * Approximate value of a quantity at a unit price, both decimal strings with up to 4 decimals,
 * rounded to cents. Display only (the ledger keeps exact quantities); uses integers in 1/10000.
 */
export function stockValue(quantity: string, price: string | null): string | null {
  if (price === null) return null;
  const scaled = (v: string) => {
    const neg = v.startsWith("-");
    const [i = "0", f = ""] = v.replace("-", "").split(".");
    const n = BigInt(i) * 10000n + BigInt((f + "0000").slice(0, 4));
    return neg ? -n : n;
  };
  const product = scaled(quantity) * scaled(price); // in 1/10^8
  const cents = (product + (product >= 0n ? 500000n : -500000n)) / 1000000n;
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** Sum of decimal strings (display totals), exact to 4 decimals. */
export function sumDecimals(values: readonly string[]): string {
  const total = values.reduce((acc, v) => {
    const neg = v.startsWith("-");
    const [i = "0", f = ""] = v.replace("-", "").split(".");
    const n = BigInt(i) * 10000n + BigInt((f + "0000").slice(0, 4));
    return acc + (neg ? -n : n);
  }, 0n);
  const abs = total < 0n ? -total : total;
  const frac = String(abs % 10000n)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return `${total < 0n ? "-" : ""}${abs / 10000n}${frac ? `.${frac}` : ""}`;
}

/** Sum of money amounts (decimal strings), shown with exactly two decimals. */
export function sumMoney(values: readonly string[]): string {
  const [int, frac = ""] = sumDecimals(values).split(".");
  return `${int}.${(frac + "00").slice(0, 2)}`;
}
