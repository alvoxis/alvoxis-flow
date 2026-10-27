import { describe, expect, it } from "vitest";
import {
  bucketKeys,
  bucketOf,
  daysIn,
  parseRange,
  presetRange,
  previousRange,
} from "@/features/dashboard/range";

/** Dashboard periods: presets, custom ranges, previous period, chart buckets. */
describe("dashboard ranges", () => {
  const today = "2026-05-14";
  it("resolves the presets", () => {
    expect(presetRange("this_month", today)).toMatchObject({
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(presetRange("last_month", today)).toMatchObject({
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(presetRange("this_quarter", today)).toMatchObject({
      from: "2026-04-01",
      to: "2026-06-30",
    });
    expect(presetRange("this_year", today)).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(presetRange("last_month", "2026-01-10")).toMatchObject({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(presetRange("this_month", "2024-02-10").to).toBe("2024-02-29");
  });

  it("accepts only valid custom ranges", () => {
    expect(parseRange({ range: "custom", from: "2026-01-15", to: "2026-02-15" }, today)).toEqual({
      preset: "custom",
      from: "2026-01-15",
      to: "2026-02-15",
    });
    for (const bad of [
      { from: "2026-02-15", to: "2026-01-15" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2020-01-01", to: "2026-01-01" },
      { from: "x", to: "y" },
    ])
      expect(parseRange({ range: "custom", ...bad }, today).preset).toBe("this_month");
    expect(parseRange({ range: "weird" }, today).preset).toBe("this_month");
  });

  it("compares with the previous period of the same length and buckets by day or month", () => {
    expect(previousRange({ from: "2026-05-01", to: "2026-05-31" })).toEqual({
      from: "2026-03-31",
      to: "2026-04-30",
    });
    expect(daysIn({ from: "2026-01-01", to: "2026-12-31" })).toBe(365);
    expect(bucketOf({ from: "2026-05-01", to: "2026-05-31" })).toBe("day");
    expect(bucketKeys({ from: "2026-05-30", to: "2026-06-02" })).toEqual([
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
    ]);
    expect(bucketKeys({ from: "2025-11-15", to: "2026-02-10" })).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("percentChange", () => {
  it("compares against the previous value's magnitude", async () => {
    const { percentChange } = await import("@/features/dashboard/compare");
    expect(percentChange("120.00", "100.00")).toBe("+20.0");
    expect(percentChange("50", "100")).toBe("-50.0");
    expect(percentChange("-50", "-100")).toBe("+50.0");
    expect(percentChange("100", "0")).toBeNull();
    expect(percentChange("100", "100")).toBe("0.0");
  });
});
