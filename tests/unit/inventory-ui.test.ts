import { describe, expect, it } from "vitest";
import {
  emptyOperation,
  stockValue,
  sumDecimals,
  sumMoney,
  toOperationBody,
} from "@/features/inventory/model";

describe("inventory display arithmetic", () => {
  it("values stock at a price, rounded half away from zero to cents", () => {
    expect(stockValue("10.5", "29.9")).toBe("313.95");
    expect(stockValue("0.0001", "0.0049")).toBe("0.00");
    expect(stockValue("3", "0.005")).toBe("0.02");
    expect(stockValue("-2", "1.005")).toBe("-2.01");
    expect(stockValue("12345678901234.9999", "1")).toBe("12345678901235.00");
    expect(stockValue("5", null)).toBeNull();
  });

  it("sums decimal strings exactly", () => {
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["10.4999", "-0.4999"])).toBe("10");
    expect(sumDecimals([])).toBe("0");
    expect(sumDecimals(["-1.5", "0.25"])).toBe("-1.25");
  });

  it("shows money sums with two decimals", () => {
    expect(sumMoney(["125.00"])).toBe("125.00");
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
    expect(sumMoney([])).toBe("0.00");
    expect(sumMoney(["-1.50"])).toBe("-1.50");
  });
});

describe("stock operation body", () => {
  const base = { ...emptyOperation("2026-03-02", "w1"), productId: "p1", quantity: " 2 " };

  it("sends only the fields of the chosen kind", () => {
    expect(toOperationBody({ ...base, unitCost: "1", toWarehouseId: "w2" })).toEqual({
      kind: "receipt",
      productId: "p1",
      warehouseId: "w1",
      quantity: "2",
      unitCost: "1",
      occurredOn: "2026-03-02",
      reference: null,
      note: null,
    });
    const transfer = toOperationBody({
      ...base,
      kind: "transfer",
      toWarehouseId: "w2",
      unitCost: "1",
    });
    expect(transfer).toMatchObject({ toWarehouseId: "w2" });
    expect(transfer).not.toHaveProperty("unitCost");
    expect(toOperationBody({ ...base, kind: "count" })).not.toHaveProperty("toWarehouseId");
  });
});
