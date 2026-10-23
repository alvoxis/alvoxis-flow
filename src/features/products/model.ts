import { type CategoryOption, chooseCategory } from "@/features/documents/editor-model";
import { orNull } from "@/features/records/api";
import { type DocumentLine } from "@/modules/documents/domain/types";

/** A product as the products API returns it. */
export interface ProductItem {
  id: string;
  kind: "goods" | "service";
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  barcode: string | null;
  currency: string;
  salePrice: string | null;
  purchasePrice: string | null;
  taxCategoryId: string | null;
  trackStock: boolean;
  archived: boolean;
  version: number;
}

export interface ProductDraft {
  kind: "goods" | "service";
  sku: string;
  name: string;
  description: string;
  unit: string;
  barcode: string;
  currency: string;
  salePrice: string;
  purchasePrice: string;
  taxCategoryId: string;
  trackStock: boolean;
}

export const EMPTY_PRODUCT: ProductDraft = {
  kind: "goods",
  sku: "",
  name: "",
  description: "",
  unit: "pcs",
  barcode: "",
  currency: "EUR",
  salePrice: "",
  purchasePrice: "",
  taxCategoryId: "",
  trackStock: false,
};

export function productDraftOf(p: ProductItem): ProductDraft {
  return {
    kind: p.kind,
    sku: p.sku ?? "",
    name: p.name,
    description: p.description ?? "",
    unit: p.unit,
    barcode: p.barcode ?? "",
    currency: p.currency,
    salePrice: p.salePrice ?? "",
    purchasePrice: p.purchasePrice ?? "",
    taxCategoryId: p.taxCategoryId ?? "",
    trackStock: p.trackStock,
  };
}

/** Request body: trimmed text, empty optional fields as null; the server validates prices. */
export function toProductBody(d: ProductDraft) {
  return {
    kind: d.kind,
    sku: orNull(d.sku),
    name: d.name.trim(),
    description: orNull(d.description),
    unit: d.unit.trim(),
    barcode: orNull(d.barcode),
    currency: d.currency,
    salePrice: orNull(d.salePrice),
    purchasePrice: orNull(d.purchasePrice),
    taxCategoryId: d.taxCategoryId || null,
    trackStock: d.kind === "goods" && d.trackStock,
  };
}

/**
 * A new document line from a product: name and unit; on priced documents also the sale price
 * (when the currencies match) and the product's tax category (when it is still offered).
 * Everything stays editable on the line.
 */
export function lineFromProduct(
  id: string,
  p: ProductItem,
  doc: { currency: string; priced: boolean; categories: readonly CategoryOption[] },
): DocumentLine {
  const line: DocumentLine = {
    id,
    kind: "item",
    description: p.name,
    quantity: "1",
    unit: p.unit,
    unitPrice:
      doc.priced && p.salePrice !== null && p.currency === doc.currency ? p.salePrice : null,
    taxCategory: null,
  };
  const category = doc.priced ? doc.categories.find((c) => c.id === p.taxCategoryId) : undefined;
  return category ? chooseCategory(line, category) : line;
}
