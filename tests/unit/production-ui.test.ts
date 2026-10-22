import { describe, expect, it } from "vitest";
import { compareDecimals } from "@/features/production/model";

describe("compareDecimals", () => {
  it("compares exactly to 4 decimals, signs included", () => {
    expect(compareDecimals("7", "8")).toBe(-1);
    expect(compareDecimals("8.0000", "8")).toBe(0);
    expect(compareDecimals("0.0002", "0.0001")).toBe(1);
    expect(compareDecimals("-1", "0")).toBe(-1);
    expect(compareDecimals("12345678901234.9999", "12345678901235")).toBe(-1);
  });
});
