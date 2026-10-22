import { describe, expect, it } from "vitest";
import { type CategoryOption } from "@/features/documents/editor-model";
import {
  EMPTY_PRODUCT,
  lineFromProduct,
  type ProductItem,
  productDraftOf,
  toProductBody,
} from "@/features/products/model";

const CAT: CategoryOption = {
  id: "cat-1",
  code: "S20",
  kind: "standard",
  ratePercent: "20",
  label: "Fixture 20 %",
  note: null,
};

const PRODUCT: ProductItem = {
  id: "p1",
  kind: "goods",
  sku: "WJ-001",
  name: "Winter jacket",
  description: null,
  unit: "pcs",
  barcode: null,
  currency: "EUR",
  salePrice: "65.5",
  purchasePrice: null,
  taxCategoryId: "cat-1",
  trackStock: true,
  archived: false,
  version: 2,
};

describe("product form model", () => {
  it("sends trimmed text, empty fields as null, and never tracks stock for services", () => {
    expect(
      toProductBody({ ...EMPTY_PRODUCT, name: " Hour ", kind: "service", trackStock: true }),
    ).toEqual({
      kind: "service",
      sku: null,
      name: "Hour",
      description: null,
      unit: "pcs",
      barcode: null,
      currency: "EUR",
      salePrice: null,
      purchasePrice: null,
      taxCategoryId: null,
      trackStock: false,
    });
    expect(toProductBody(productDraftOf(PRODUCT))).toMatchObject({
      sku: "WJ-001",
      salePrice: "65.5",
      taxCategoryId: "cat-1",
      trackStock: true,
    });
  });
});

describe("lineFromProduct", () => {
  const doc = { currency: "EUR", priced: true, categories: [CAT] };

  it("copies name, unit, price and the offered tax category", () => {
    expect(lineFromProduct("l1", PRODUCT, doc)).toEqual({
      id: "l1",
      kind: "item",
      description: "Winter jacket",
      quantity: "1",
      unit: "pcs",
      unitPrice: "65.5",
      taxCategoryId: "cat-1",
      taxCategory: { code: "S20", kind: "standard", ratePercent: "20", label: "Fixture 20 %" },
    });
  });

  it("leaves the price empty in another currency and the category when it is not offered", () => {
    const line = lineFromProduct("l1", PRODUCT, { ...doc, currency: "PLN", categories: [] });
    expect(line).toMatchObject({ unitPrice: null, taxCategory: null });
    expect(line).not.toHaveProperty("taxCategoryId");
  });

  it("adds neither price nor category on delivery notes", () => {
    expect(lineFromProduct("l1", PRODUCT, { ...doc, priced: false })).toMatchObject({
      unitPrice: null,
      taxCategory: null,
      unit: "pcs",
    });
  });
});
